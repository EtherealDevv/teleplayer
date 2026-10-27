export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppSettings {
  themeMode: ThemeMode
  seedColor: string
  useSystemAccent: boolean
  cacheLimitGb: number
}

export interface AuthUser {
  id: string
  firstName: string
  lastName?: string
  username?: string
  phone?: string
  premium?: boolean
}

export type AuthStatus =
  | 'no-credentials'
  | 'signed-out'
  | 'connecting'
  | 'code-sent'
  | 'password-needed'
  | 'authorized'
  | 'error'

export interface AuthState {
  status: AuthStatus
  user?: AuthUser
  phone?: string
  channelTitle?: string
  error?: string
  codeViaApp?: boolean
  codeViaEmail?: boolean
  apiConfigured: boolean
}

export interface Folder {
  id: string
  name: string
  emoji: string
  color: string
  createdAt: number
}

export interface VideoItem {
  id: string
  name: string
  title: string
  size: number
  mime?: string
  duration?: number
  width?: number
  height?: number
  folderId: string | null
  parts: number
  addedAt: number
  cached: boolean
  hasThumb: boolean
  thumbUrl?: string
  watchPosition?: number
  watchDuration?: number
  watchedAt?: number
}

export interface Library {
  folders: Folder[]
  videos: VideoItem[]
  channelTitle: string
  totalSize: number
  user?: AuthUser
}

export interface DetectedCountry {
  code: string
  name: string
  dialCode: string
}

export interface BootstrapData {
  settings: AppSettings
  auth: AuthState
  library: Library | null
  appVersion: string
  accentColor: string
  detectedCountry?: DetectedCountry
}

export type ImportStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'done'
  | 'error'
  | 'cancelled'

export interface ImportProgress {
  jobId: string
  videoId: string
  name: string
  title: string
  folderId: string | null
  size: number
  partIndex: number
  partCount: number
  uploadedBytes: number
  totalBytes: number
  speed: number
  status: ImportStatus
  detail?: string
  error?: string
}

export type DownloadStatus =
  | 'downloading'
  | 'done'
  | 'error'
  | 'cancelled'

export interface DownloadProgress {
  videoId: string
  status: DownloadStatus
  downloadedBytes: number
  totalBytes: number
  speed: number
  error?: string
}

export type StreamStatus = 'streaming' | 'idle' | 'cached' | 'error'

/**
 * Estado de la caché progresiva que se usa al reproducir directamente desde
 * Telegram. `cachedBytes` son los bytes que ya están guardados en disco, no
 * una estimación del búfer del reproductor.
 */
export interface StreamProgress {
  videoId: string
  status: StreamStatus
  cachedBytes: number
  totalBytes: number
  speed: number
  error?: string
}

export interface CacheInfo {
  bytes: number
  files: number
  limitBytes: number
}

export interface PlaybackOpenResult {
  cached: boolean
  url?: string
  state: DownloadProgress | null
  stream?: StreamProgress | null
}

export interface ThumbEvent {
  videoId: string
  url: string
}

export interface AppUpdate {
  settings?: Partial<AppSettings>
}

export interface FolderInput {
  name: string
  emoji: string
  color: string
}

export interface WindowApi {
  bootstrap(): Promise<BootstrapData>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setTitlebar(colors: { color: string; symbolColor: string }): Promise<void>
  openExternal(url: string): Promise<void>

  auth: {
    configure(apiId: string, apiHash: string): Promise<AuthState>
    sendCode(phone: string): Promise<AuthState>
    signIn(code: string): Promise<AuthState>
    password(password: string): Promise<AuthState>
    reconnect(): Promise<AuthState>
    logout(): Promise<AuthState>
    resetCredentials(): Promise<AuthState>
    state(): Promise<AuthState>
  }

  library: {
    refresh(silent?: boolean): Promise<Library>
    importDialog(folderId: string | null): Promise<{ cancelled: boolean; count: number }>
    deleteVideo(videoId: string): Promise<void>
    moveVideo(videoId: string, folderId: string | null): Promise<void>
    renameVideo(videoId: string, title: string): Promise<void>
    thumb(videoId: string): Promise<string | null>
    createFolder(input: FolderInput): Promise<Library>
    renameFolder(folderId: string, input: FolderInput): Promise<Library>
    deleteFolder(folderId: string): Promise<Library>
    cacheInfo(): Promise<CacheInfo>
    clearCache(): Promise<CacheInfo>
    openCacheFolder(): Promise<void>
  }

  playback: {
    open(videoId: string): Promise<PlaybackOpenResult>
    status(videoId: string): Promise<DownloadProgress | null>
    streamStatus(videoId: string): Promise<StreamProgress | null>
    url(videoId: string): Promise<string | null>
    cancel(videoId: string): Promise<void>
    download(videoId: string): Promise<void>
    setActive(videoId: string | null): Promise<void>
    saveProgress(videoId: string, position: number, duration: number): Promise<void>
    openExternal(videoId: string): Promise<void>
    reveal(videoId: string): Promise<void>
  }

  events: {
    onAuthChanged(cb: (state: AuthState) => void): void
    onImportProgress(cb: (job: ImportProgress) => void): void
    onDownloadProgress(cb: (state: DownloadProgress) => void): void
    onStreamProgress(cb: (state: StreamProgress) => void): void
    onLibraryChanged(cb: () => void): void
    onThumb(cb: (event: ThumbEvent) => void): void
  }
}
