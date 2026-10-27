import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, CacheInfo, Folder, ThemeMode } from '../shared/types'

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

  private cleanupOrphanedCache(): void {
    const known = new Set(Object.values(this.state.cache).map((entry) => entry.fileName))
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (known.has(name)) continue
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
      cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : {}
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
      }
    }
    delete this.state.cache[videoId]
    const thumb = this.getThumbPath(videoId)
    if (thumb) {
      try {
        fs.rmSync(thumb, { force: true })
      } catch {
        // Ignore locked thumbnails.
      }
    }
    this.persist()
  }

  getThumbPath(videoId: string): string | null {
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(videoId)) return null
    return path.join(this.thumbsDir, `${videoId}.jpg`)
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

  cacheInfo(): CacheInfo {
    let bytes = 0
    let files = 0
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
    return {
      bytes,
      files,
      limitBytes: this.settings.cacheLimitGb * 1024 * 1024 * 1024
    }
  }

  pruneCache(excludeVideoId?: string, protectedIds?: Set<string>): string[] {
    const limitGb = this.settings.cacheLimitGb
    if (!limitGb || limitGb <= 0) return []
    const limit = limitGb * 1024 * 1024 * 1024
    const entries = Object.entries(this.state.cache).sort(
      (a, b) => a[1].downloadedAt - b[1].downloadedAt
    )
    let total = entries.reduce((sum, [, entry]) => sum + entry.size, 0)
    const evicted: string[] = []
    for (const [videoId, entry] of entries) {
      if (total <= limit) break
      if (videoId === excludeVideoId || protectedIds?.has(videoId)) continue
      const file = this.safeCachePath(entry.fileName)
      if (file) {
        try {
          fs.rmSync(file, { force: true })
          total -= entry.size
          delete this.state.cache[videoId]
          evicted.push(videoId)
        } catch {
          // File is likely being played; try again next time.
        }
      } else {
        total -= entry.size
        delete this.state.cache[videoId]
        evicted.push(videoId)
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
