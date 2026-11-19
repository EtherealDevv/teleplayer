import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, CacheInfo, Folder, ThemeMode } from '../shared/types'
import { CHUNK_SIZE, MANIFEST_SUFFIX, MANIFEST_VERSION } from './cache-format'
import type { FileFingerprint } from './fingerprint'

interface WatchEntry {
  t: number
  d: number
  at: number
}

interface CacheEntry {
  fileName: string
  size: number
  downloadedAt: number
}

interface ChannelInfo {
  id: string
  accessHash: string
  title: string
}

/** Alias locales del formato compartido con `MediaStreamer`. */
const PARTIAL_MANIFEST_VERSION = MANIFEST_VERSION
const PARTIAL_CHUNK_SIZE = CHUNK_SIZE
const PARTIAL_SUFFIX = MANIFEST_SUFFIX

interface PartialCacheFile {
  fileName: string
  filePath: string
  manifestPath: string
  bytes: number
  modifiedAt: number
}

interface PersistedState {
  version: 1
  apiId?: number
  apiHash?: string
  session?: string
  channel?: ChannelInfo
  indexMessageId?: number
  foldersCache?: Folder[]
  settings: AppSettings
  watch: Record<string, WatchEntry>
  cache: Record<string, CacheEntry>
  /** Huella de contenido por vídeo, para no volver a subir un archivo renombrado. */
  fingerprints?: Record<string, FileFingerprint>
}

const DEFAULTS: AppSettings = {
  themeMode: 'system',
  seedColor: '#3390EC',
  useSystemAccent: false,
  cacheLimitGb: 20
}

function seal(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(value).toString('base64')}`
    }
  } catch {
    // Fall through to base64.
  }
  return `b64:${Buffer.from(value, 'utf8').toString('base64')}`
}

function unseal(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    if (value.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    }
    if (value.startsWith('b64:')) {
      return Buffer.from(value.slice(4), 'base64').toString('utf8')
    }
    return value
  } catch {
    return undefined
  }
}

function sanitizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  const seed = typeof input?.seedColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.seedColor)
    ? input.seedColor
    : DEFAULTS.seedColor
  const modes: ThemeMode[] = ['system', 'light', 'dark']
  const mode = modes.includes(input?.themeMode as ThemeMode)
    ? (input?.themeMode as ThemeMode)
    : DEFAULTS.themeMode
  const limit = Number(input?.cacheLimitGb)
  return {
    themeMode: mode,
    seedColor: seed,
    useSystemAccent:
      typeof input?.useSystemAccent === 'boolean'
        ? input.useSystemAccent
        : DEFAULTS.useSystemAccent,
    cacheLimitGb: Number.isFinite(limit) && limit >= 0 ? Math.min(500, limit) : DEFAULTS.cacheLimitGb
  }
}

export class AppStore {
  readonly rootDir: string
  readonly cacheDir: string
  readonly thumbsDir: string
  private readonly stateFile: string
  private state: PersistedState

  constructor() {
    this.rootDir = app.getPath('userData')
    this.cacheDir = path.join(this.rootDir, 'cache', 'videos')
    this.thumbsDir = path.join(this.rootDir, 'cache', 'thumbs')
    this.stateFile = path.join(this.rootDir, 'teleplayer.json')
    fs.mkdirSync(this.cacheDir, { recursive: true })
    fs.mkdirSync(this.thumbsDir, { recursive: true })
    this.state = this.load()
    this.cleanupOrphanedCache()
  }

  /**
   * Deja en la caché solo lo que se puede reutilizar: descargas completas
   * registradas y pares vídeo+manifiesto de la caché progresiva. Antes se
   * borraba todo lo que no estuviera en `state.cache`, así que cada reinicio
   * tiraba lo descargado a medias y la reanudación moría con la app.
   */
  private cleanupOrphanedCache(): void {
    const completed = new Set(Object.values(this.state.cache).map((entry) => entry.fileName))
    const partials = this.listPartialCaches()
    const keep = new Set<string>()
    for (const partial of partials) {
      if (completed.has(partial.fileName)) continue
      keep.add(partial.fileName)
      keep.add(`${partial.fileName}${PARTIAL_SUFFIX}`)
    }
    for (const fileName of completed) {
      keep.add(fileName)
      if (fs.existsSync(path.join(this.cacheDir, `${fileName}${PARTIAL_SUFFIX}`))) {
        keep.add(`${fileName}${PARTIAL_SUFFIX}`)
      }
    }
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (keep.has(name)) continue
        try {
          fs.rmSync(path.join(this.cacheDir, name), { force: true })
        } catch {
          // The file may be locked by another process; try again next start.
        }
      }
    } catch {
      // The cache folder may not exist yet.
    }
  }

  /**
   * Pares manifiesto+vídeo de la caché progresiva. Un manifiesto sin su vídeo
   * (o al revés) no sirve para reanudar nada y se descarta al arrancar.
   */
  private listPartialCaches(): PartialCacheFile[] {
    const result: PartialCacheFile[] = []
    let entries: string[]
    try {
      entries = fs.readdirSync(this.cacheDir)
    } catch {
      return result
    }
    for (const name of entries) {
      if (!name.endsWith(PARTIAL_SUFFIX)) continue
      const manifestPath = path.join(this.cacheDir, name)
      const fileName = name.slice(0, -PARTIAL_SUFFIX.length)
      const filePath = path.join(this.cacheDir, fileName)
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          version?: number
          totalSize?: number
          chunkSize?: number
        }
        if (
          parsed.version !== PARTIAL_MANIFEST_VERSION ||
          parsed.chunkSize !== PARTIAL_CHUNK_SIZE ||
          !Number.isFinite(parsed.totalSize) ||
          Number(parsed.totalSize) <= 0
        ) {
          continue
        }
        const stat = fs.statSync(filePath)
        if (!stat.isFile() || stat.size <= 0) continue
        result.push({
          fileName,
          filePath,
          manifestPath,
          bytes: stat.size,
          modifiedAt: stat.mtimeMs
        })
      } catch {
        // Manifiesto ilegible o vídeo ausente: no se puede reanudar.
      }
    }
    return result
  }

  private load(): PersistedState {
    let raw: Partial<PersistedState> = {}
    try {
      raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedState>
    } catch {
      raw = {}
    }
    return {
      version: 1,
      apiId: typeof raw.apiId === 'number' ? raw.apiId : undefined,
      apiHash: typeof raw.apiHash === 'string' ? raw.apiHash : undefined,
      session: typeof raw.session === 'string' ? raw.session : undefined,
      channel: raw.channel,
      indexMessageId: typeof raw.indexMessageId === 'number' ? raw.indexMessageId : undefined,
      foldersCache: Array.isArray(raw.foldersCache) ? raw.foldersCache : [],
      settings: sanitizeSettings(raw.settings),
      watch: raw.watch && typeof raw.watch === 'object' ? raw.watch : {},
      cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : {},
      fingerprints:
        raw.fingerprints && typeof raw.fingerprints === 'object' ? raw.fingerprints : {}
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (error) {
      console.error('No se pudo guardar la configuración', error)
    }
  }

  get settings(): AppSettings {
    return { ...this.state.settings }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = sanitizeSettings({ ...this.state.settings, ...patch })
    this.persist()
    return this.settings
  }

  getCredentialInfo(): { apiId?: number; apiHash?: string } {
    return {
      apiId: this.state.apiId,
      apiHash: unseal(this.state.apiHash)
    }
  }

  setCredentials(apiId: number, apiHash: string): void {
    this.state.apiId = apiId
    this.state.apiHash = seal(apiHash)
    this.persist()
  }

  clearCredentials(): void {
    delete this.state.apiId
    delete this.state.apiHash
    delete this.state.session
    this.persist()
  }

  get session(): string | undefined {
    return unseal(this.state.session)
  }

  setSession(session: string): void {
    this.state.session = seal(session)
    this.persist()
  }

  clearSession(): void {
    delete this.state.session
    this.persist()
  }

  get channel(): ChannelInfo | undefined {
    return this.state.channel
  }

  setChannel(channel: ChannelInfo): void {
    this.state.channel = channel
    this.persist()
  }

  clearChannel(): void {
    delete this.state.channel
    this.persist()
  }

  get indexMessageId(): number | undefined {
    return this.state.indexMessageId
  }

  setIndexMessageId(id: number | undefined): void {
    if (id === undefined) delete this.state.indexMessageId
    else this.state.indexMessageId = id
    this.persist()
  }

  get foldersCache(): Folder[] {
    return Array.isArray(this.state.foldersCache) ? this.state.foldersCache : []
  }

  setFoldersCache(folders: Folder[]): void {
    this.state.foldersCache = folders
    this.persist()
  }

  getWatch(videoId: string): WatchEntry | undefined {
    return this.state.watch[videoId]
  }

  getWatchMap(): Record<string, WatchEntry> {
    return this.state.watch
  }

  setWatch(videoId: string, position: number, duration: number): void {
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return
    const now = Date.now()
    if (position < 3 || position > duration - 3) {
      if (position > duration * 0.95) {
        this.state.watch[videoId] = { t: Math.max(0, duration - 2), d: duration, at: now }
      } else {
        delete this.state.watch[videoId]
      }
    } else {
      this.state.watch[videoId] = { t: position, d: duration, at: now }
    }
    const entries = Object.entries(this.state.watch)
    if (entries.length > 400) {
      entries.sort((a, b) => b[1].at - a[1].at)
      this.state.watch = Object.fromEntries(entries.slice(0, 400))
    }
    this.persist()
  }

  removeWatch(videoId: string): void {
    if (!this.state.watch[videoId]) return
    delete this.state.watch[videoId]
    this.persist()
  }

  private safeCachePath(fileName: string): string | null {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return null
    return path.join(this.cacheDir, fileName)
  }

  getCacheFile(videoId: string): string | null {
    const entry = this.state.cache[videoId]
    if (!entry) return null
    const file = this.safeCachePath(entry.fileName)
    if (!file) return null
    try {
      const stat = fs.statSync(file)
      if (stat.isFile() && stat.size > 0) return file
    } catch {
      // Stale entry, remove below.
    }
    delete this.state.cache[videoId]
    this.persist()
    return null
  }

  isCached(videoId: string): boolean {
    return this.getCacheFile(videoId) !== null
  }

  addCache(videoId: string, fileName: string, size: number): void {
    this.state.cache[videoId] = { fileName, size, downloadedAt: Date.now() }
    this.persist()
  }

  removeCache(videoId: string): void {
    const entry = this.state.cache[videoId]
    if (entry) {
      const file = this.safeCachePath(entry.fileName)
      if (file) {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          // The player may still hold the file; it will be cleaned up later.
        }
        try {
          fs.rmSync(`${file}${PARTIAL_SUFFIX}`, { force: true })
        } catch {
          // Same as the video file: retried on the next startup cleanup.
        }
      }
    }
    delete this.state.cache[videoId]
    this.removeThumb(videoId)
    this.removeFingerprint(videoId)
    this.persist()
  }

  getThumbPath(videoId: string): string | null {
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(videoId)) return null
    return path.join(this.thumbsDir, `${videoId}.jpg`)
  }

  /**
   * Restos de la caché progresiva de un vídeo que ya no existe: el archivo
   * `${videoId}<ext>` y su manifiesto. Sin esto, borrar un vídeo a medias dejaba
   * sus bloques en disco hasta el siguiente arranque.
   */
  removePartialCache(videoId: string): void {
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(videoId)) return
    let entries: string[]
    try {
      entries = fs.readdirSync(this.cacheDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.startsWith(`${videoId}.`)) continue
      try {
        fs.rmSync(path.join(this.cacheDir, name), { force: true })
      } catch {
        // Locked by the player; the startup cleanup retries.
      }
    }
  }

  hasThumb(videoId: string): boolean {
    const file = this.getThumbPath(videoId)
    if (!file) return false
    try {
      return fs.statSync(file).size > 0
    } catch {
      return false
    }
  }

  /** Borra la portada de un vídeo que no llegó a entrar en la biblioteca. */
  removeThumb(videoId: string): void {
    const file = this.getThumbPath(videoId)
    if (!file) return
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // A locked JPEG is retried with the rest of the cache cleanup.
    }
  }

  /**
   * Portadas sin vídeo en la biblioteca (importaciones fallidas, vídeos
   * borrados desde Telegram). `keep` lo calcula el servicio, que es quien
   * conoce el índice.
   */
  pruneThumbs(keep: Set<string>): number {
    let removed = 0
    let entries: string[]
    try {
      entries = fs.readdirSync(this.thumbsDir)
    } catch {
      return removed
    }
    for (const name of entries) {
      if (!name.endsWith('.jpg')) continue
      const videoId = name.slice(0, -4)
      if (keep.has(videoId)) continue
      try {
        fs.rmSync(path.join(this.thumbsDir, name), { force: true })
        removed += 1
      } catch {
        // Locked by the renderer; next start will try again.
      }
    }
    return removed
  }

  /** Huellas de contenido de la biblioteca: hash → vídeo. */
  fingerprintIndex(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [videoId, fingerprint] of Object.entries(this.state.fingerprints ?? {})) {
      if (fingerprint && typeof fingerprint.hash === 'string') map.set(fingerprint.hash, videoId)
    }
    return map
  }

  setFingerprint(videoId: string, fingerprint: FileFingerprint): void {
    this.state.fingerprints = { ...(this.state.fingerprints ?? {}), [videoId]: fingerprint }
    this.persist()
  }

  removeFingerprint(videoId: string): void {
    const fingerprints = this.state.fingerprints
    if (!fingerprints || !(videoId in fingerprints)) return
    delete fingerprints[videoId]
    this.persist()
  }

  cacheInfo(): CacheInfo {
    let bytes = 0
    let files = 0
    const completed = new Set(Object.values(this.state.cache).map((entry) => entry.fileName))
    for (const [, entry] of Object.entries(this.state.cache)) {
      const file = this.safeCachePath(entry.fileName)
      if (!file) continue
      try {
        const stat = fs.statSync(file)
        if (stat.isFile()) {
          bytes += stat.size
          files += 1
        }
      } catch {
        // Ignore stale entries.
      }
    }
    let partialBytes = 0
    let partialFiles = 0
    for (const partial of this.listPartialCaches()) {
      if (completed.has(partial.fileName)) continue
      partialBytes += partial.bytes
      partialFiles += 1
    }
    return {
      bytes,
      files,
      limitBytes: this.settings.cacheLimitGb * 1024 * 1024 * 1024,
      partialBytes,
      partialFiles
    }
  }

  pruneCache(excludeVideoId?: string, protectedIds?: Set<string>): string[] {
    const limitGb = this.settings.cacheLimitGb
    if (!limitGb || limitGb <= 0) return []
    const limit = limitGb * 1024 * 1024 * 1024
    const entries = Object.entries(this.state.cache)
      .sort((a, b) => a[1].downloadedAt - b[1].downloadedAt)
      .map(([videoId, entry]) => {
        const file = this.safeCachePath(entry.fileName)
        let size = entry.size
        if (file) {
          try {
            size = fs.statSync(file).size
          } catch {
            // Keep the registered size when the file is already gone.
          }
        }
        return { videoId, entry, file, size }
      })
    const completedNames = new Set(entries.map((item) => item.entry.fileName))
    const partials = this.listPartialCaches()
      .filter((partial) => !completedNames.has(partial.fileName))
      .sort((a, b) => a.modifiedAt - b.modifiedAt)
    let total =
      entries.reduce((sum, item) => sum + item.size, 0) +
      partials.reduce((sum, partial) => sum + partial.bytes, 0)
    const evicted: string[] = []
    const isProtected = (videoId: string): boolean =>
      videoId === excludeVideoId || Boolean(protectedIds?.has(videoId))
    for (const { videoId, entry, file, size } of entries) {
      if (total <= limit) break
      if (isProtected(videoId)) continue
      if (!file) {
        total -= size
        delete this.state.cache[videoId]
        evicted.push(videoId)
        continue
      }
      try {
        fs.rmSync(file, { force: true })
        fs.rmSync(`${file}${PARTIAL_SUFFIX}`, { force: true })
        total -= size
        delete this.state.cache[videoId]
        evicted.push(videoId)
      } catch {
        // File is likely being played; try again next time.
      }
    }
    // La caché progresiva también ocupa disco. Si después de vaciar las
    // descargas completas se sigue por encima del límite, se van los bloques
    // más viejos (los que llevan más tiempo sin reproducirse).
    for (const partial of partials) {
      if (total <= limit) break
      if (excludeVideoId && partial.fileName.startsWith(excludeVideoId)) continue
      try {
        fs.rmSync(partial.filePath, { force: true })
        fs.rmSync(partial.manifestPath, { force: true })
        total -= partial.bytes
      } catch {
        // Locked by the player; next prune will pick it up.
      }
    }
    if (evicted.length > 0) this.persist()
    return evicted
  }

  clearCache(): CacheInfo {
    for (const [videoId, entry] of Object.entries(this.state.cache)) {
      const file = this.safeCachePath(entry.fileName)
      if (!file) {
        delete this.state.cache[videoId]
        continue
      }
      try {
        fs.rmSync(file, { force: true })
        delete this.state.cache[videoId]
      } catch {
        // Keep the entry so the UI can report what is still taking space.
      }
    }
    try {
      for (const name of fs.readdirSync(this.thumbsDir)) {
        try {
          fs.rmSync(path.join(this.thumbsDir, name), { force: true })
        } catch {
          // Ignore locked thumbnails.
        }
      }
    } catch {
      // The thumbnail folder may not exist yet.
    }
    this.persist()
    return this.cacheInfo()
  }

  findFolder(folderId: string | null): Folder | undefined {
    if (!folderId) return undefined
    return this.foldersCache.find((folder) => folder.id === folderId)
  }
}
