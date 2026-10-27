import { Api, TelegramClient, password as passwordCrypto } from 'teleproto'
import { StringSession } from 'teleproto/sessions'
import { getFileInfo } from 'teleproto/Utils'
import bigInt from 'big-integer'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import type {
  AuthState,
  AuthUser,
  CacheInfo,
  DownloadProgress,
  Folder,
  FolderInput,
  ImportProgress,
  Library,
  PlaybackOpenResult,
  StreamProgress,
  ThumbEvent,
  VideoItem
} from '../shared/types'
import type { AppStore } from './store'
import {
  extensionFromFileName,
  folderIndexText,
  FOLDER_MARK,
  isVideoFileName,
  mimeForName,
  normalizeTitle,
  parseFolderIndex,
  parseVideoCaption,
  StoredMeta,
  titleFromFileName,
  videoCaption
} from './caption'
import { errorText } from './errors'
import { probeVideo } from './media'
import { parseRange } from './protocol'
import { fetchStreamRangeFromParts } from './stream-range'
import { MediaStreamer, type StreamSource } from './streaming'
import { downloadPartToStream, fileLimitFor, uploadRange } from './transfer'

const CHANNEL_TITLE = 'TelePlayer · Videoteca'
const CHANNEL_ABOUT = 'Videoteca de TelePlayer. Los vídeos se guardan aquí como backup en Telegram. No borres este canal ni sus mensajes.'
const HISTORY_LIMIT = 1500
const MEDIA_URL = 'tp-media://video/'
const THUMB_URL = 'tp-media://thumb/'

interface StoredPart {
  messageId: number
  part: number
  size: number
}

interface InternalVideo {
  meta: StoredMeta
  parts: StoredPart[]
  thumbType?: string
}

interface ServiceEvents {
  auth: (state: AuthState) => void
  importProgress: (job: ImportProgress) => void
  downloadProgress: (state: DownloadProgress) => void
  streamProgress: (state: StreamProgress) => void
  libraryChanged: () => void
  thumb: (event: ThumbEvent) => void
}

interface StreamPartSource {
  start: number
  size: number
  dcId: number
  location: Api.TypeInputFileLocation
}

interface DownloadJob {
  controller: AbortController
  state: DownloadProgress
  promise: Promise<void>
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value
  const maybe = value as { toJSNumber?: () => number }
  if (maybe && typeof maybe.toJSNumber === 'function') return maybe.toJSNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '')
}

function pickThumb(message: Api.Message): Api.PhotoSize | undefined {
  const thumbs = message.document?.thumbs
  if (!thumbs || thumbs.length === 0) return undefined
  const candidates = thumbs
    .filter((thumb): thumb is Api.PhotoSize => thumb instanceof Api.PhotoSize && thumb.size > 0)
    .sort((a, b) => a.size - b.size)
  return candidates.length > 0 ? candidates[candidates.length - 1] : undefined
}

function pickThumbType(message: Api.Message): string | undefined {
  return pickThumb(message)?.type
}

function isPasswordNeeded(error: unknown): boolean {
  const message = String((error as { errorMessage?: string })?.errorMessage ?? (error as Error)?.message ?? error)
  return message.includes('SESSION_PASSWORD_NEEDED')
}

export class TelegramService {
  private store: AppStore
  private events: ServiceEvents
  private client: TelegramClient | null = null
  private clientPromise: Promise<TelegramClient> | null = null
  private peer: Api.InputPeerChannel | null = null
  private channelPromise: Promise<Api.InputPeerChannel> | null = null
  private auth: AuthState
  private me: AuthUser | undefined
  private pending: { phone: string; phoneCodeHash: string; emailCode?: boolean } | null = null
  private folders: Folder[] | null = null
  private videoIndex = new Map<string, InternalVideo>()
  private thumbQueue: string[] = []
  private thumbBusy = new Set<string>()
  private importQueue: Promise<void> = Promise.resolve()
  private importJobs = new Map<string, ImportProgress>()
  private activeImports = 0
  private downloadJobs = new Map<string, DownloadJob>()
  private streamSources = new Map<string, Promise<StreamSource>>()
  private streamer: MediaStreamer
  private lastThumbRefresh = 0
  private activeVideoId: string | null = null

  constructor(store: AppStore, events: ServiceEvents) {
    this.store = store
    this.events = events
    this.streamer = new MediaStreamer(store.cacheDir, (state) => this.events.streamProgress(state))
    const credentials = store.getCredentialInfo()
    const configured = Boolean(credentials.apiId && credentials.apiHash)
    this.auth = {
      status: configured ? (store.session ? 'connecting' : 'signed-out') : 'no-credentials',
      apiConfigured: configured
    }
  }

  get state(): AuthState {
    return { ...this.auth }
  }

  async bootstrap(): Promise<void> {
    const credentials = this.store.getCredentialInfo()
    if (!credentials.apiId || !credentials.apiHash) {
      this.setAuth({ status: 'no-credentials', apiConfigured: false })
      return
    }
    if (!this.store.session) {
      this.setAuth({ status: 'signed-out', apiConfigured: true })
      return
    }
    await this.reconnect()
  }

  async reconnect(): Promise<AuthState> {
    const credentials = this.store.getCredentialInfo()
    if (!credentials.apiId || !credentials.apiHash) {
      this.setAuth({ status: 'no-credentials', apiConfigured: false })
      return this.state
    }
    if (!this.store.session) {
      this.setAuth({ status: 'signed-out', apiConfigured: true })
      return this.state
    }
    this.setAuth({ status: 'connecting', apiConfigured: true, error: undefined })
    try {
      const client = await this.ensureClient()
      await this.connect()
      const authorized = await client.checkAuthorization()
      if (!authorized) {
        await this.disconnectClient()
        this.store.clearSession()
        this.setAuth({
          status: 'signed-out',
          apiConfigured: true,
          user: undefined,
          phone: undefined,
          channelTitle: undefined,
          error: undefined
        })
        return this.state
      }
      await this.finishAuth()
      return this.state
    } catch (error) {
      const message = String(error)
      if (
        message.includes('AUTH_KEY_UNREGISTERED') ||
        message.includes('SESSION_REVOKED') ||
        message.includes('AUTH_KEY_DUPLICATED') ||
        message.includes('USER_DEACTIVATED')
      ) {
        await this.disconnectClient()
        this.store.clearSession()
        this.setAuth({
          status: 'signed-out',
          apiConfigured: true,
          user: undefined,
          phone: undefined,
          channelTitle: undefined,
          error: errorText(error)
        })
      } else {
        this.setAuth({ status: 'error', apiConfigured: true, error: errorText(error) })
      }
      return this.state
    }
  }

  async configure(apiIdRaw: string, apiHashRaw: string): Promise<AuthState> {
    const apiId = Number(String(apiIdRaw).trim())
    const apiHash = String(apiHashRaw).trim().toLowerCase()
    if (!Number.isInteger(apiId) || apiId <= 0 || apiId > 99_999_999) {
      throw new Error('El api_id debe ser un número. Puedes copiarlo desde my.telegram.org.')
    }
    if (!/^[0-9a-f]{32}$/.test(apiHash)) {
      throw new Error('El api_hash debe tener 32 caracteres hexadecimales.')
    }
    await this.disconnectClient()
    this.store.setCredentials(apiId, apiHash)
    this.store.clearSession()
    this.store.clearChannel()
    this.store.setIndexMessageId(undefined)
    this.store.setFoldersCache([])
    this.pending = null
    this.me = undefined
    this.peer = null
    this.videoIndex.clear()
    this.folders = null
    this.setAuth({
      status: 'signed-out',
      apiConfigured: true,
      user: undefined,
      phone: undefined,
      error: undefined,
      channelTitle: undefined
    })
    return this.state
  }

  async sendCode(phoneRaw: string): Promise<AuthState> {
    const phone = cleanPhone(phoneRaw)
    if (!/^\+?\d{7,16}$/.test(phone)) {
      throw new Error('Escribe el número con el prefijo del país, por ejemplo +34 600 000 000.')
    }
    const credentials = this.store.getCredentialInfo()
    if (!credentials.apiId || !credentials.apiHash) {
      throw new Error('Primero configura tus credenciales API.')
    }
    try {
      const client = await this.ensureClient()
      await this.connect()
      const result = await client.sendCode(
        { apiId: credentials.apiId, apiHash: credentials.apiHash },
        phone
      )
      if (result.emailRequired) {
        throw new Error('LOGIN_EMAIL_REQUIRED')
      }
      this.pending = {
        phone,
        phoneCodeHash: result.phoneCodeHash,
        emailCode: result.emailCodeSent === true
      }
      this.setAuth({
        status: 'code-sent',
        apiConfigured: true,
        phone,
        codeViaApp: result.isCodeViaApp,
        codeViaEmail: result.emailCodeSent === true,
        error: undefined
      })
      return this.state
    } catch (error) {
      throw new Error(errorText(error))
    }
  }

  async signIn(codeRaw: string): Promise<AuthState> {
    const code = String(codeRaw).replace(/\s+/g, '')
    if (!code) throw new Error('Escribe el código que recibiste en Telegram.')
    if (!this.pending) throw new Error('Solicita un código nuevo antes de continuar.')
    const credentials = this.store.getCredentialInfo()
    if (!credentials.apiId || !credentials.apiHash) {
      throw new Error('Faltan las credenciales API.')
    }
    try {
      const client = await this.ensureClient()
      await this.connect()
      const signIn = this.pending.emailCode
        ? new Api.auth.SignIn({
            phoneNumber: this.pending.phone,
            phoneCodeHash: this.pending.phoneCodeHash,
            emailVerification: new Api.EmailVerificationCode({ code })
          })
        : new Api.auth.SignIn({
            phoneNumber: this.pending.phone,
            phoneCodeHash: this.pending.phoneCodeHash,
            phoneCode: code
          })
      const result = await client.invoke(signIn)
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error('PHONE_NUMBER_UNOCCUPIED')
      }
      await this.finishAuth()
      return this.state
    } catch (error) {
      if (isPasswordNeeded(error)) {
        this.setAuth({
          status: 'password-needed',
          apiConfigured: true,
          phone: this.pending?.phone,
          error: undefined
        })
        return this.state
      }
      throw new Error(errorText(error))
    }
  }

  async password(passwordRaw: string): Promise<AuthState> {
    if (!passwordRaw) throw new Error('Escribe tu contraseña de verificación en dos pasos.')
    const credentials = this.store.getCredentialInfo()
    if (!credentials.apiId || !credentials.apiHash) {
      throw new Error('Faltan las credenciales API.')
    }
    try {
      const client = await this.ensureClient()
      await this.connect()
      const accountPassword = await client.invoke(new Api.account.GetPassword())
      const check = await passwordCrypto.computeCheck(accountPassword, passwordRaw)
      await client.invoke(new Api.auth.CheckPassword({ password: check }))
      await this.finishAuth()
      return this.state
    } catch (error) {
      throw new Error(errorText(error))
    }
  }

  async logout(): Promise<AuthState> {
    if (this.activeImports > 0) {
      throw new Error('Espera a que terminen las importaciones antes de cerrar sesión.')
    }
    try {
      if (this.client?.connected) {
        await this.client.logOut().catch(() => undefined)
      }
    } catch {
      // Local cleanup still happens below.
    }
    await this.disconnectClient()
    this.store.clearSession()
    this.store.clearChannel()
    this.store.setIndexMessageId(undefined)
    this.store.setFoldersCache([])
    this.store.clearCache()
    this.pending = null
    this.me = undefined
    this.peer = null
    this.folders = null
    this.videoIndex.clear()
    this.downloadJobs.forEach((job) => job.controller.abort())
    this.downloadJobs.clear()
    this.setAuth({
      status: this.store.getCredentialInfo().apiId ? 'signed-out' : 'no-credentials',
      apiConfigured: Boolean(this.store.getCredentialInfo().apiId),
      user: undefined,
      phone: undefined,
      channelTitle: undefined,
      error: undefined
    })
    return this.state
  }

  async resetCredentials(): Promise<AuthState> {
    if (this.activeImports > 0) {
      throw new Error('Espera a que terminen las importaciones antes de cambiar las credenciales.')
    }
    await this.disconnectClient()
    this.downloadJobs.forEach((job) => job.controller.abort())
    this.downloadJobs.clear()
    this.store.clearCredentials()
    this.store.clearChannel()
    this.store.setIndexMessageId(undefined)
    this.store.setFoldersCache([])
    this.store.clearCache()
    this.pending = null
    this.me = undefined
    this.peer = null
    this.folders = null
    this.videoIndex.clear()
    this.setAuth({
      status: 'no-credentials',
      apiConfigured: false,
      user: undefined,
      phone: undefined,
      channelTitle: undefined,
      error: undefined
    })
    return this.state
  }

  private setAuth(patch: Partial<AuthState>): void {
    this.auth = { ...this.auth, ...patch }
    this.events.auth(this.state)
  }

  private async ensureClient(): Promise<TelegramClient> {
    if (this.client) return this.client
    if (this.clientPromise) return this.clientPromise
    const credentials = this.store.getCredentialInfo()
    if (!credentials.apiId || !credentials.apiHash) {
      throw new Error('API_NO_CREDENTIALS')
    }
    this.clientPromise = (async () => {
      const client = new TelegramClient(
        new StringSession(this.store.session ?? ''),
        credentials.apiId!,
        credentials.apiHash!,
        {
          connectionRetries: 8,
          autoReconnect: true,
          floodSleepThreshold: 40,
          deviceModel: 'TelePlayer Desktop',
          systemVersion: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
          appVersion: app.getVersion(),
          langCode: 'es'
        }
      )
      this.client = client
      return client
    })()
    try {
      return await this.clientPromise
    } finally {
      this.clientPromise = null
    }
  }

  private async connect(): Promise<TelegramClient> {
    const client = await this.ensureClient()
    if (!client.connected) await client.connect()
    return client
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client
    this.client = null
    this.clientPromise = null
    this.channelPromise = null
    this.peer = null
    if (!client) return
    try {
      await client.disconnect()
    } catch {
      // Ignore disconnection errors.
    }
  }

  private async finishAuth(): Promise<void> {
    const client = await this.connect()
    const me = await client.getMe()
    if (!(me instanceof Api.User)) throw new Error('No se pudo leer tu perfil de Telegram.')
    this.me = {
      id: me.id.toString(),
      firstName: me.firstName || 'Telegram',
      lastName: me.lastName ?? undefined,
      username: me.username ?? undefined,
      phone: me.phone ?? undefined,
      premium: Boolean(me.premium)
    }
    const saved = client.session.save()
    if (typeof saved === 'string' && saved.length > 0) this.store.setSession(saved)
    this.setAuth({
      status: 'authorized',
      apiConfigured: true,
      user: this.me,
      phone: this.me.phone ?? this.pending?.phone,
      channelTitle: this.store.channel?.title,
      error: undefined,
      codeViaApp: undefined,
      codeViaEmail: undefined
    })
    this.pending = null
    void this.ensureChannel()
      .then((channel) => {
        this.setAuth({ status: 'authorized', channelTitle: this.store.channel?.title ?? CHANNEL_TITLE })
        return channel
      })
      .catch((error) => {
        this.setAuth({ status: 'authorized', error: errorText(error) })
      })
  }

  private async ensureChannel(): Promise<Api.InputPeerChannel> {
    if (this.peer) return this.peer
    if (this.channelPromise) return this.channelPromise
    this.channelPromise = this.resolveChannel()
    try {
      const peer = await this.channelPromise
      this.peer = peer
      return peer
    } finally {
      this.channelPromise = null
    }
  }

  private async resolveChannel(): Promise<Api.InputPeerChannel> {
    const client = await this.connect()
    const stored = this.store.channel
    if (stored?.id && stored.accessHash) {
      const peer = new Api.InputPeerChannel({
        channelId: bigInt(stored.id),
        accessHash: bigInt(stored.accessHash)
      })
      try {
        await client.getMessages(peer, { limit: 1 })
        return peer
      } catch (error) {
        if (
          String(error).includes('CHANNEL_INVALID') ||
          String(error).includes('CHANNEL_PRIVATE') ||
          String(error).includes('PEER_ID_INVALID')
        ) {
          this.store.clearChannel()
          this.store.setIndexMessageId(undefined)
        } else {
          throw error
        }
      }
    }

    for await (const dialog of client.iterDialogs({ limit: 300 })) {
      const entity = dialog.entity
      if (entity instanceof Api.Channel && entity.title === CHANNEL_TITLE) {
        if (!entity.accessHash) continue
        const peer = new Api.InputPeerChannel({
          channelId: entity.id,
          accessHash: entity.accessHash
        })
        this.store.setChannel({
          id: entity.id.toString(),
          accessHash: entity.accessHash.toString(),
          title: entity.title
        })
        return peer
      }
    }

    const created = await client.invoke(
      new Api.channels.CreateChannel({
        title: CHANNEL_TITLE,
        about: CHANNEL_ABOUT,
        broadcast: true
      })
    )
    if (!(created instanceof Api.Updates)) {
      throw new Error('Telegram no devolvió el canal creado.')
    }
    const channel = created.chats.find(
      (chat): chat is Api.Channel => chat instanceof Api.Channel
    )
    if (!channel?.accessHash) throw new Error('Telegram no devolvió el canal creado.')
    const peer = new Api.InputPeerChannel({
      channelId: channel.id,
      accessHash: channel.accessHash
    })
    this.store.setChannel({
      id: channel.id.toString(),
      accessHash: channel.accessHash.toString(),
      title: channel.title
    })
    try {
      await client.sendMessage(peer, {
        message: '🎬 Videoteca de TelePlayer\n\nAquí se guardan tus vídeos y sus copias de seguridad. TelePlayer organiza las carpetas con los mensajes de este canal.',
        formattingEntities: [],
        silent: true
      })
    } catch {
      // The welcome message is optional.
    }
    return peer
  }

  async listLibrary(): Promise<Library> {
    await this.requireAuthorized()
    const peer = await this.ensureChannel()
    const client = await this.connect()

    const messages: Api.Message[] = []
    for await (const message of client.iterMessages(peer, { limit: HISTORY_LIMIT, waitTime: 0 })) {
      if (message instanceof Api.Message) messages.push(message)
      if (messages.length >= HISTORY_LIMIT) break
    }

    const grouped = new Map<
      string,
      { metas: StoredMeta[]; parts: StoredPart[]; thumbType?: string }
    >()
    for (const message of messages) {
      const document = message.document
      if (!document) continue
      const meta = parseVideoCaption(message.text)
      if (!meta) continue
      const entry = grouped.get(meta.id) ?? { metas: [], parts: [] }
      entry.metas.push(meta)
      entry.parts.push({
        messageId: message.id,
        part: meta.part,
        size: numberOf(document.size)
      })
      if (meta.part === 0) entry.thumbType = pickThumbType(message)
      grouped.set(meta.id, entry)
    }

    const nextIndex = new Map<string, InternalVideo>()
    for (const [id, entry] of grouped) {
      entry.parts.sort((a, b) => a.part - b.part)
      const primary =
        entry.metas.find((meta) => meta.part === 0) ??
        [...entry.metas].sort((a, b) => a.part - b.part)[0]
      if (!primary) continue
      const partCount = Math.max(primary.parts, entry.parts.length)
      const size = primary.size || entry.parts.reduce((sum, part) => sum + part.size, 0)
      nextIndex.set(id, {
        meta: {
          ...primary,
          parts: partCount,
          size
        },
        parts: entry.parts,
        thumbType: entry.thumbType
      })
    }
    this.videoIndex = nextIndex

    this.folders = await this.loadFolders(peer, [...nextIndex.values()].map((video) => video.meta))
    this.queueThumbnails()
    return this.buildLibrary()
  }

  private buildLibrary(): Library {
    const videos: VideoItem[] = []
    for (const [id, internal] of this.videoIndex) {
      const meta = internal.meta
      const watch = this.store.getWatch(id)
      const cached = this.store.isCached(id)
      const hasThumb = this.store.hasThumb(id)
      videos.push({
        id,
        name: meta.n,
        title: meta.ti,
        size: meta.size,
        mime: meta.mime,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        folderId: meta.folderId,
        parts: meta.parts,
        addedAt: meta.addedAt,
        cached,
        hasThumb: hasThumb || Boolean(internal.thumbType),
        thumbUrl: hasThumb ? `${THUMB_URL}${id}` : undefined,
        watchPosition: watch?.t,
        watchDuration: watch?.d,
        watchedAt: watch?.at
      })
    }
    videos.sort((a, b) => b.addedAt - a.addedAt)
    return {
      folders: this.folders ?? [],
      videos,
      channelTitle: this.store.channel?.title ?? CHANNEL_TITLE,
      totalSize: videos.reduce((sum, video) => sum + video.size, 0),
      user: this.auth.user
    }
  }

  private async loadFolders(peer: Api.InputPeerChannel, metas: StoredMeta[]): Promise<Folder[]> {
    let folders: Folder[] | null = null
    const indexId = this.store.indexMessageId
    if (indexId) {
      try {
        const found = await this.connect().then((client) =>
          client.getMessages(peer, { ids: indexId })
        )
        const message = found[0]
        if (message) folders = parseFolderIndex(message.text)
      } catch {
        this.store.setIndexMessageId(undefined)
      }
    }
    if (!folders) {
      try {
        const client = await this.connect()
        const found = await client.getMessages(peer, { search: 'TPF1', limit: 20 })
        for (const message of found) {
          const parsed = parseFolderIndex(message.text)
          if (parsed) {
            folders = parsed
            this.store.setIndexMessageId(message.id)
            break
          }
        }
      } catch {
        // Fall back to the local cache below.
      }
    }
    if (!folders) folders = this.store.foldersCache

    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    for (const meta of metas) {
      if (meta.folderId && !byId.has(meta.folderId)) {
        byId.set(meta.folderId, {
          id: meta.folderId,
          name: meta.folderName || 'Carpeta',
          emoji: '🎬',
          color: '#3390EC',
          createdAt: meta.addedAt
        })
      }
    }
    const result = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
    this.store.setFoldersCache(result)
    return result
  }

  private async saveFolders(peer: Api.InputPeerChannel, folders: Folder[]): Promise<void> {
    const client = await this.connect()
    const text = folderIndexText(folders)
    const existingId = this.store.indexMessageId
    if (existingId) {
      try {
        await client.editMessage(peer, { message: existingId, text, formattingEntities: [] })
        this.store.setFoldersCache(folders)
        return
      } catch {
        this.store.setIndexMessageId(undefined)
      }
    }
    const sent = await client.sendMessage(peer, {
      message: text,
      formattingEntities: [],
      silent: true
    })
    this.store.setIndexMessageId(sent.id)
    try {
      await client.pinMessage(peer, sent.id, { notify: false })
    } catch {
      // A pinned index is a convenience, not a requirement.
    }
    this.store.setFoldersCache(folders)
  }

  private async currentFolders(): Promise<Folder[]> {
    if (!this.folders) await this.listLibrary()
    return this.folders ?? []
  }

  async createFolder(input: FolderInput): Promise<Library> {
    const name = input.name.trim()
    if (!name) throw new Error('Ponle un nombre a la carpeta.')
    const existing = await this.currentFolders()
    if (existing.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Ya existe una carpeta con ese nombre.')
    }
    const folder: Folder = {
      id: randomUUID(),
      name: name.slice(0, 48),
      emoji: input.emoji || '🎬',
      color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#6750A4',
      createdAt: Date.now()
    }
    const folders = [...existing, folder]
    const peer = await this.ensureChannel()
    await this.saveFolders(peer, folders)
    this.folders = folders
    return this.buildLibrary()
  }

  async renameFolder(folderId: string, input: FolderInput): Promise<Library> {
    const existing = await this.currentFolders()
    const folder = existing.find((item) => item.id === folderId)
    if (!folder) throw new Error('Esa carpeta ya no existe.')
    const name = input.name.trim()
    if (!name) throw new Error('Ponle un nombre a la carpeta.')
    if (
      existing.some(
        (item) => item.id !== folderId && item.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      throw new Error('Ya existe una carpeta con ese nombre.')
    }
    const folders = existing.map((item) =>
      item.id === folderId
        ? {
            ...item,
            name: name.slice(0, 48),
            emoji: input.emoji || item.emoji,
            color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : item.color
          }
        : item
    )
    const peer = await this.ensureChannel()
    await this.saveFolders(peer, folders)
    this.folders = folders
    return this.buildLibrary()
  }

  async deleteFolder(folderId: string): Promise<Library> {
    if (this.activeImports > 0) {
      throw new Error('Espera a que terminen las importaciones antes de eliminar una carpeta.')
    }
    const existing = await this.currentFolders()
    if (!existing.some((folder) => folder.id === folderId)) return this.buildLibrary()
    const affected = [...this.videoIndex.values()].filter(
      (video) => video.meta.folderId === folderId
    )
    for (const video of affected) {
      await this.updateVideoMeta(video, { folderId: null, folderName: undefined })
    }
    const folders = existing.filter((folder) => folder.id !== folderId)
    const peer = await this.ensureChannel()
    await this.saveFolders(peer, folders)
    this.folders = folders
    return this.buildLibrary()
  }

  async moveVideo(videoId: string, folderId: string | null): Promise<void> {
    await this.requireAuthorized()
    if (!this.videoIndex.size) await this.listLibrary()
    const video = this.videoIndex.get(videoId)
    if (!video) throw new Error('Ese vídeo ya no está en la biblioteca.')
    const folders = await this.currentFolders()
    const folder = folderId ? folders.find((item) => item.id === folderId) : undefined
    if (folderId && !folder) throw new Error('La carpeta de destino no existe.')
    await this.updateVideoMeta(video, {
      folderId: folder?.id ?? null,
      folderName: folder?.name
    })
    this.events.libraryChanged()
  }

  async renameVideo(videoId: string, titleRaw: string): Promise<void> {
    await this.requireAuthorized()
    if (!this.videoIndex.size) await this.listLibrary()
    const video = this.videoIndex.get(videoId)
    if (!video) throw new Error('Ese vídeo ya no está en la biblioteca.')
    const title = normalizeTitle(titleRaw)
    if (!title) throw new Error('El título no puede estar vacío.')
    await this.updateVideoMeta(video, { ti: title })
    this.events.libraryChanged()
  }

  private async updateVideoMeta(video: InternalVideo, patch: Partial<StoredMeta>): Promise<void> {
    const peer = await this.ensureChannel()
    const client = await this.connect()
    const next: StoredMeta = { ...video.meta, ...patch }
    for (const part of video.parts) {
      const caption = videoCaption({
        ...next,
        part: part.part,
        parts: video.meta.parts
      })
      await client.editMessage(peer, {
        message: part.messageId,
        text: caption,
        formattingEntities: []
      })
    }
    video.meta = next
  }

  async deleteVideo(videoId: string): Promise<void> {
    await this.requireAuthorized()
    if (!this.videoIndex.size) await this.listLibrary()
    const video = this.videoIndex.get(videoId)
    if (!video) return
    const job = this.downloadJobs.get(videoId)
    if (job) {
      job.controller.abort()
      await job.promise.catch(() => undefined)
      this.downloadJobs.delete(videoId)
    }
    const peer = await this.ensureChannel()
    const client = await this.connect()
    await client.deleteMessages(
      peer,
      video.parts.map((part) => part.messageId),
      { revoke: true }
    )
    this.videoIndex.delete(videoId)
    await this.streamer.remove(videoId)
    this.streamSources.delete(videoId)
    this.store.removeCache(videoId)
    this.store.removeWatch(videoId)
    this.events.libraryChanged()
  }

  async thumb(videoId: string): Promise<string | null> {
    if (this.store.hasThumb(videoId)) return `${THUMB_URL}${videoId}`
    await this.downloadThumb(videoId)
    return this.store.hasThumb(videoId) ? `${THUMB_URL}${videoId}` : null
  }

  private queueThumbnails(): void {
    const now = Date.now()
    if (now - this.lastThumbRefresh < 3000) return
    this.lastThumbRefresh = now
    for (const [id] of this.videoIndex) {
      if (!this.store.hasThumb(id) && !this.thumbBusy.has(id) && !this.thumbQueue.includes(id)) {
        this.thumbQueue.push(id)
      }
    }
    this.pumpThumbs()
  }

  private pumpThumbs(): void {
    while (this.thumbBusy.size < 2 && this.thumbQueue.length > 0) {
      const id = this.thumbQueue.shift()
      if (!id) break
      if (this.store.hasThumb(id)) continue
      this.thumbBusy.add(id)
      void this.downloadThumb(id).finally(() => {
        this.thumbBusy.delete(id)
        this.pumpThumbs()
      })
    }
  }

  private async downloadThumb(videoId: string): Promise<void> {
    if (this.store.hasThumb(videoId)) return
    const internal = this.videoIndex.get(videoId)
    if (!internal) return
    const first = internal.parts[0]
    if (!first) return
    const thumbPath = this.store.getThumbPath(videoId)
    if (!thumbPath) return
    try {
      const client = await this.connect()
      const peer = await this.ensureChannel()
      const messages = await client.getMessages(peer, { ids: first.messageId })
      const message = messages[0]
      if (!message) return
      const thumb = pickThumb(message)
      if (!thumb) return
      await client.downloadMedia(message, { thumb, outputFile: thumbPath })
      if (!this.videoIndex.has(videoId)) {
        fs.rmSync(thumbPath, { force: true })
        return
      }
      if (this.store.hasThumb(videoId)) {
        this.events.thumb({ videoId, url: `${THUMB_URL}${videoId}` })
      }
    } catch {
      // Thumbnails are decorative; a failure is not fatal.
    }
  }

  queueImport(paths: string[], folderId: string | null): number {
    const valid = paths.filter((file) => {
      try {
        const stat = fs.statSync(file)
        return stat.isFile() && isVideoFileName(file)
      } catch {
        return false
      }
    })
    for (const file of valid) {
      this.activeImports += 1
      this.importQueue = this.importQueue
        .then(() => this.importFile(file, folderId))
        .catch((error) => {
          console.error('Error importando', file, error)
        })
        .finally(() => {
          this.activeImports = Math.max(0, this.activeImports - 1)
        })
    }
    return valid.length
  }

  private async importFile(file: string, folderId: string | null): Promise<void> {
    const stat = fs.statSync(file)
    const name = path.basename(file)
    const job: ImportProgress = {
      jobId: randomUUID(),
      videoId: randomUUID(),
      name,
      title: titleFromFileName(name),
      folderId,
      size: stat.size,
      partIndex: 0,
      partCount: Math.max(1, Math.ceil(stat.size / fileLimitFor(this.me?.premium))),
      uploadedBytes: 0,
      totalBytes: stat.size,
      speed: 0,
      status: 'preparing',
      detail: 'Analizando el vídeo…'
    }
    this.importJobs.set(job.jobId, job)
    this.emitImport(job)

    let peer: Api.InputPeerChannel | null = null
    const uploadedIds: number[] = []
    try {
      await this.requireAuthorized()
      const client = await this.connect()
      peer = await this.ensureChannel()
      const folders = await this.currentFolders()
      const folder = folderId ? folders.find((item) => item.id === folderId) : undefined
      const probe = await probeVideo(file)
      const mime = mimeForName(name)
      const ext = extensionFromFileName(name).toLowerCase()
      const fileLimit = fileLimitFor(this.me?.premium)
      const parts = Math.max(1, Math.ceil(stat.size / fileLimit))
      const supportsStreaming = ['.mp4', '.m4v', '.mov', '.webm'].includes(ext)
      job.partCount = parts
      this.emitImport(job)

      let uploadedBefore = 0
      let lastEmit = Date.now()
      const speedSamples: Array<{ at: number; bytes: number }> = [
        { at: Date.now(), bytes: 0 }
      ]
      const emitProgress = (force = false): void => {
        const now = Date.now()
        if (!force && now - lastEmit < 300) return
        speedSamples.push({ at: now, bytes: job.uploadedBytes })
        while (speedSamples.length > 2 && now - speedSamples[0].at > 3000) {
          speedSamples.shift()
        }
        const first = speedSamples[0]
        const seconds = (now - first.at) / 1000
        job.speed = seconds >= 0.4 ? Math.max(0, (job.uploadedBytes - first.bytes) / seconds) : 0
        lastEmit = now
        this.emitImport(job)
      }

      for (let part = 0; part < parts; part += 1) {
        const start = part * fileLimit
        const partBytes = Math.min(stat.size - start, fileLimit)
        const partName =
          parts > 1
            ? part === 0
              ? name
              : `${path.basename(name, path.extname(name))} (parte ${part + 1} de ${parts})${path.extname(name)}`
            : name
        const meta: StoredMeta = {
          v: 1,
          id: job.videoId,
          n: name,
          ti: job.title,
          part,
          parts,
          size: stat.size,
          mime,
          duration: probe.duration,
          width: probe.width,
          height: probe.height,
          folderId: folder?.id ?? null,
          folderName: folder?.name,
          addedAt: Date.now()
        }
        job.status = 'uploading'
        job.partIndex = part
        job.uploadedBytes = uploadedBefore
        job.speed = 0
        speedSamples.length = 0
        speedSamples.push({ at: Date.now(), bytes: uploadedBefore })
        job.detail = parts > 1 ? `Subiendo parte ${part + 1} de ${parts}` : 'Subiendo a Telegram'
        this.emitImport(job)

        const attributes: Api.TypeDocumentAttribute[] = [
          new Api.DocumentAttributeFilename({ fileName: partName })
        ]
        if (probe.duration && probe.width && probe.height) {
          attributes.unshift(
            new Api.DocumentAttributeVideo({
              duration: probe.duration,
              w: probe.width,
              h: probe.height,
              supportsStreaming
            })
          )
        }

        const inputFile = await uploadRange({
          client,
          filePath: file,
          offset: start,
          length: partBytes,
          name: partName,
          onProgress: (uploaded) => {
            job.uploadedBytes = Math.min(stat.size, uploadedBefore + uploaded)
            emitProgress()
          }
        })
        const media = new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: mime,
          attributes,
          forceFile: true
        })
        const sent = await client.sendFile(peer, {
          file: media,
          caption: videoCaption(meta),
          formattingEntities: [],
          silent: true
        })
        uploadedIds.push(sent.id)
        uploadedBefore += partBytes
        job.uploadedBytes = Math.min(stat.size, uploadedBefore)
        emitProgress(true)
      }

      job.status = 'done'
      job.uploadedBytes = stat.size
      job.speed = 0
      job.detail = parts > 1 ? `Guardado en Telegram · ${parts} partes` : 'Guardado en Telegram'
      this.emitImport(job)
      this.events.libraryChanged()
    } catch (error) {
      if (peer && uploadedIds.length > 0) {
        try {
          const client = await this.connect()
          await client.deleteMessages(peer, uploadedIds, { revoke: true })
        } catch {
          // Leave the partial upload in the channel if cleanup fails.
        }
      }
      job.status = 'error'
      job.speed = 0
      job.error = errorText(error)
      this.emitImport(job)
    } finally {
      setTimeout(() => this.importJobs.delete(job.jobId), 120_000)
    }
  }

  private emitImport(job: ImportProgress): void {
    this.events.importProgress({ ...job })
  }

  async open(videoId: string): Promise<PlaybackOpenResult> {
    await this.requireAuthorized()
    const cached = this.store.getCacheFile(videoId)
    if (cached) {
      return {
        cached: true,
        url: `${MEDIA_URL}${videoId}`,
        state: this.downloadJobs.get(videoId)?.state ?? null,
        stream: this.streamer.progress(videoId)
      }
    }
    if (!this.videoIndex.size) await this.listLibrary()
    if (!this.videoIndex.has(videoId)) {
      await this.listLibrary()
    }
    if (!this.videoIndex.has(videoId)) throw new Error('Ese vídeo ya no está disponible en Telegram.')
    const existing = this.downloadJobs.get(videoId)
    if (existing) {
      if (existing.state.status === 'downloading') {
        return { cached: false, state: { ...existing.state }, stream: this.streamer.progress(videoId) }
      }
      this.downloadJobs.delete(videoId)
    }

    const previousStream = this.streamer.progress(videoId)
    if (previousStream?.status === 'error') {
      await this.streamer.close(videoId)
      this.streamSources.delete(videoId)
    }

    // Preparamos la fuente de streaming (una consulta de mensajes, no la
    // descarga del archivo) para que el primer fotograma llegue cuanto antes.
    await this.ensureStreamSource(videoId)
    return {
      cached: false,
      url: `${MEDIA_URL}${videoId}`,
      state: null,
      stream: this.streamer.progress(videoId)
    }
  }

  url(videoId: string): string | null {
    return this.store.isCached(videoId) ? `${MEDIA_URL}${videoId}` : null
  }

  status(videoId: string): DownloadProgress | null {
    const job = this.downloadJobs.get(videoId)
    return job ? { ...job.state } : null
  }

  streamStatus(videoId: string): StreamProgress | null {
    return this.streamer.progress(videoId)
  }

  async serveMedia(videoId: string, request: Request): Promise<Response> {
    const source = await this.ensureStreamSource(videoId)
    const totalSize = source.totalSize
    if (totalSize <= 0) return new Response('Not found', { status: 404 })
    const range = parseRange(request.headers.get('range'), totalSize)
    const headers = new Headers()
    headers.set('Content-Type', source.mime)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', 'no-store')

    if (request.headers.get('range') && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end : totalSize - 1
    headers.set('Content-Length', String(end - start + 1))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`)
    if (request.method === 'HEAD') {
      return new Response(null, { status: range ? 206 : 200, headers })
    }
    const body = await this.streamer.serve(source, start, end, request.signal)
    return new Response(body as unknown as ReadableStream, {
      status: range ? 206 : 200,
      headers
    })
  }

  download(videoId: string): void {
    void this.requireAuthorized()
      .then(async () => {
        if (this.store.isCached(videoId)) return
        if (!this.videoIndex.size) await this.listLibrary()
        if (!this.videoIndex.has(videoId)) {
          throw new Error('Ese vídeo ya no está disponible en Telegram.')
        }
        const existing = this.downloadJobs.get(videoId)
        if (existing) {
          if (existing.state.status === 'downloading') return
          this.downloadJobs.delete(videoId)
        }
        // La descarga completa y el streaming no deben escribir el mismo
        // archivo a la vez. Si había una caché parcial, se empieza de cero.
        await this.streamer.remove(videoId)
        this.streamSources.delete(videoId)
        this.startDownload(videoId)
      })
      .catch((error) => {
        this.events.downloadProgress({
          videoId,
          status: 'error',
          downloadedBytes: 0,
          totalBytes: 0,
          speed: 0,
          error: errorText(error)
        })
      })
  }

  private ensureStreamSource(videoId: string): Promise<StreamSource> {
    const existing = this.streamSources.get(videoId)
    if (existing) return existing
    const promise = this.createStreamSource(videoId).catch((error) => {
      this.streamSources.delete(videoId)
      throw error
    })
    this.streamSources.set(videoId, promise)
    return promise
  }

  private async createStreamSource(videoId: string): Promise<StreamSource> {
    const internal = this.videoIndex.get(videoId)
    if (!internal) throw new Error('Ese vídeo ya no está disponible en Telegram.')
    const client = await this.connect()
    const peer = await this.ensureChannel()
    const found = await client.getMessages(peer, {
      ids: internal.parts.map((part) => part.messageId)
    })
    const byId = new Map<number, Api.Message>()
    for (const message of found) {
      if (message instanceof Api.Message) byId.set(message.id, message)
    }

    const parts: StreamPartSource[] = []
    let cursor = 0
    for (const part of internal.parts) {
      const message = byId.get(part.messageId)
      if (!message) throw new Error('Falta una parte del vídeo en Telegram.')
      const info = getFileInfo(message)
      if (!info.location) throw new Error('Telegram no devolvió la ubicación del vídeo.')
      const size = part.size > 0 ? part.size : info.size ? info.size.toJSNumber() : 0
      if (size <= 0) throw new Error('Una parte del vídeo no tiene tamaño.')
      parts.push({
        start: cursor,
        size,
        dcId: info.dcId ?? client.session.dcId,
        location: info.location
      })
      cursor += size
    }
    if (parts.length === 0) throw new Error('El vídeo no tiene partes descargables.')
    const totalSize = cursor
    const fileName = `${videoId}${extensionFromFileName(internal.meta.n)}`
    const filePath = path.join(this.store.cacheDir, fileName)
    const mime = internal.meta.mime || mimeForName(internal.meta.n)
    const duration = internal.meta.duration ?? 0
    // Mantener un colchón de unos 16 s adaptado al bitrate del vídeo. En
    // conexiones malas esto da al reproductor margen para recuperarse sin
    // llenar la cola de peticiones ni descargar el archivo entero.
    const prefetchBytes =
      duration > 0
        ? Math.min(
            12 * 1024 * 1024,
            Math.max(2 * 1024 * 1024, Math.round((totalSize / duration) * 16))
          )
        : undefined

    const source: StreamSource = {
      videoId,
      filePath,
      totalSize,
      mime,
      prefetchBytes,
      fetch: (start, length, signal) =>
        this.fetchStreamRange(client, parts, start, length, signal),
      onComplete: () => {
        this.store.addCache(videoId, fileName, totalSize)
        this.events.libraryChanged()
      }
    }
    await this.streamer.prepare(source)
    return source
  }

  private fetchStreamRange(
    client: TelegramClient,
    parts: StreamPartSource[],
    start: number,
    length: number,
    signal: AbortSignal
  ): Promise<Buffer> {
    return fetchStreamRangeFromParts(
      parts,
      start,
      length,
      (part, offset, limit) =>
        client._media.getFile(
          part.dcId,
          part.location,
          bigInt(offset),
          limit,
          signal,
          (dc) => {
            part.dcId = dc
          }
        ),
      signal
    )
  }

  private startDownload(videoId: string): void {
    if (this.downloadJobs.has(videoId)) return
    const internal = this.videoIndex.get(videoId)
    if (!internal) return
    const controller = new AbortController()
    const state: DownloadProgress = {
      videoId,
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: internal.meta.size,
      speed: 0
    }
    const promise = this.runDownload(internal, controller, state)
    this.downloadJobs.set(videoId, { controller, state, promise })
    this.events.downloadProgress({ ...state })
  }

  private async runDownload(
    internal: InternalVideo,
    controller: AbortController,
    state: DownloadProgress
  ): Promise<void> {
    const videoId = state.videoId
    const extension = extensionFromFileName(internal.meta.n)
    const fileName = `${videoId}${extension}`
    const destination = path.join(this.store.cacheDir, fileName)
    let writer: fs.WriteStream | null = null
    let downloaded = 0
    let lastEmit = Date.now()
    let lastBytes = 0
    const emit = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < 250) return
      const seconds = Math.max(0.25, (now - lastEmit) / 1000)
      state.speed = Math.max(0, (downloaded - lastBytes) / seconds)
      state.downloadedBytes = downloaded
      state.status = 'downloading'
      lastEmit = now
      lastBytes = downloaded
      this.events.downloadProgress({ ...state })
    }
    try {
      const client = await this.connect()
      const peer = await this.ensureChannel()
      writer = fs.createWriteStream(destination)
      const messageIds = internal.parts.map((part) => part.messageId)
      const found = await client.getMessages(peer, { ids: messageIds })
      const byId = new Map<number, Api.Message>()
      for (const message of found) {
        if (message instanceof Api.Message) byId.set(message.id, message)
      }
      for (const part of internal.parts) {
        const message = byId.get(part.messageId)
        if (!message) throw new Error('Falta una parte del vídeo en Telegram.')
        await downloadPartToStream(
          client,
          message,
          writer,
          controller.signal,
          (bytes) => {
            if (controller.signal.aborted) return
            downloaded += bytes
            emit()
          }
        )
      }
      writer.end()
      await finished(writer)
      const stat = fs.statSync(destination)
      if (internal.meta.size > 0 && stat.size !== internal.meta.size) {
        throw new Error('La descarga quedó incompleta. Vuelve a intentarlo.')
      }
      this.store.addCache(videoId, fileName, stat.size)
      state.status = 'done'
      state.downloadedBytes = stat.size
      state.speed = 0
      this.events.downloadProgress({ ...state })
      const protectedIds = this.activeVideoId ? new Set([this.activeVideoId]) : undefined
      const evicted = this.store.pruneCache(videoId, protectedIds)
      if (evicted.length > 0) this.events.libraryChanged()
    } catch (error) {
      writer?.destroy()
      fs.rmSync(destination, { force: true })
      const cancelled = controller.signal.aborted || String(error).includes('DOWNLOAD_CANCELLED')
      state.status = cancelled ? 'cancelled' : 'error'
      state.speed = 0
      state.error = cancelled ? undefined : errorText(error)
      this.events.downloadProgress({ ...state })
    } finally {
      setTimeout(() => {
        const job = this.downloadJobs.get(videoId)
        if (job && (job.state.status === 'done' || job.state.status === 'error' || job.state.status === 'cancelled')) {
          this.downloadJobs.delete(videoId)
        }
      }, 5000)
    }
  }

  cancelDownload(videoId: string): void {
    this.downloadJobs.get(videoId)?.controller.abort()
  }

  async cancelStream(videoId: string): Promise<void> {
    await this.streamer.close(videoId)
  }

  saveProgress(videoId: string, position: number, duration: number): void {
    this.store.setWatch(videoId, position, duration)
  }

  async openExternal(videoId: string): Promise<void> {
    await this.requireAuthorized()
    let file = this.store.getCacheFile(videoId)
    if (!file) {
      if (!this.videoIndex.size) await this.listLibrary()
      const existing = this.downloadJobs.get(videoId)
      if (existing && existing.state.status === 'downloading') {
        await existing.promise
      } else {
        if (existing) this.downloadJobs.delete(videoId)
        // El reproductor del sistema necesita el archivo completo, no una
        // caché parcial. Se libera el archivo antes de descargarlo.
        await this.streamer.remove(videoId)
        this.streamSources.delete(videoId)
        this.startDownload(videoId)
        const job = this.downloadJobs.get(videoId)
        if (job) await job.promise
      }
      file = this.store.getCacheFile(videoId)
    }
    if (!file) throw new Error('No se pudo descargar el vídeo para abrirlo.')
    const { shell } = await import('electron')
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  }

  cacheInfo(): CacheInfo {
    const cached = this.store.cacheInfo()
    const partial = this.streamer.info()
    return {
      ...cached,
      bytes: cached.bytes + partial.bytes,
      files: cached.files + partial.files
    }
  }

  setActivePlayback(videoId: string | null): void {
    this.activeVideoId = videoId || null
  }

  async clearCache(): Promise<CacheInfo> {
    const jobs = [...this.downloadJobs.values()]
    for (const job of jobs) job.controller.abort()
    await Promise.allSettled(jobs.map((job) => job.promise))
    this.downloadJobs.clear()
    await this.streamer.clear()
    this.streamSources.clear()
    this.store.clearCache()
    this.events.libraryChanged()
    return this.cacheInfo()
  }

  async requireAuthorized(): Promise<void> {
    if (this.auth.status !== 'authorized') {
      if (!this.client || !this.store.session) throw new Error('NOT_AUTHORIZED')
      const ok = await this.client.checkAuthorization().catch(() => false)
      if (!ok) throw new Error('NOT_AUTHORIZED')
    }
  }
}
