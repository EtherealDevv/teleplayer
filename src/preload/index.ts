import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AuthState,
  BootstrapData,
  CacheInfo,
  DownloadProgress,
  FolderInput,
  ImportProgress,
  Library,
  PlaybackOpenResult,
  StreamProgress,
  ThumbEvent,
  WindowApi
} from '../shared/types'

const api: WindowApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  setTitlebar: (colors) => ipcRenderer.invoke('app:set-titlebar', colors),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  auth: {
    configure: (apiId: string, apiHash: string) =>
      ipcRenderer.invoke('auth:configure', apiId, apiHash),
    sendCode: (phone: string) => ipcRenderer.invoke('auth:send-code', phone),
    signIn: (code: string) => ipcRenderer.invoke('auth:sign-in', code),
    password: (password: string) => ipcRenderer.invoke('auth:password', password),
    reconnect: () => ipcRenderer.invoke('auth:reconnect'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    resetCredentials: () => ipcRenderer.invoke('auth:reset-credentials'),
    state: () => ipcRenderer.invoke('auth:state')
  },
  library: {
    refresh: (silent?: boolean) => ipcRenderer.invoke('library:refresh', silent),
    importDialog: (folderId: string | null) =>
      ipcRenderer.invoke('library:import-dialog', folderId),
    deleteVideo: (videoId: string) => ipcRenderer.invoke('library:delete-video', videoId),
    moveVideo: (videoId: string, folderId: string | null) =>
      ipcRenderer.invoke('library:move-video', videoId, folderId),
    renameVideo: (videoId: string, title: string) =>
      ipcRenderer.invoke('library:rename-video', videoId, title),
    thumb: (videoId: string) => ipcRenderer.invoke('library:thumb', videoId),
    createFolder: (input: FolderInput) => ipcRenderer.invoke('folder:create', input),
    renameFolder: (folderId: string, input: FolderInput) =>
      ipcRenderer.invoke('folder:rename', folderId, input),
    deleteFolder: (folderId: string) => ipcRenderer.invoke('folder:delete', folderId),
    cacheInfo: () => ipcRenderer.invoke('library:cache-info'),
    clearCache: () => ipcRenderer.invoke('library:clear-cache'),
    openCacheFolder: () => ipcRenderer.invoke('library:open-cache-folder')
  },
  playback: {
    open: (videoId: string) => ipcRenderer.invoke('playback:open', videoId),
    status: (videoId: string) => ipcRenderer.invoke('playback:status', videoId),
    streamStatus: (videoId: string) => ipcRenderer.invoke('playback:stream-status', videoId),
    url: (videoId: string) => ipcRenderer.invoke('playback:url', videoId),
    cancel: (videoId: string) => ipcRenderer.invoke('playback:cancel', videoId),
    download: (videoId: string) => ipcRenderer.invoke('playback:download', videoId),
    setActive: (videoId: string | null) => ipcRenderer.invoke('playback:set-active', videoId),
    saveProgress: (videoId: string, position: number, duration: number) =>
      ipcRenderer.invoke('playback:save-progress', videoId, position, duration),
    openExternal: (videoId: string) => ipcRenderer.invoke('playback:open-external', videoId),
    reveal: (videoId: string) => ipcRenderer.invoke('playback:reveal', videoId)
  },
  events: {
    onAuthChanged: (cb: (state: AuthState) => void) => {
      ipcRenderer.on('auth:changed', (_event, state: AuthState) => cb(state))
    },
    onImportProgress: (cb: (job: ImportProgress) => void) => {
      ipcRenderer.on('import:progress', (_event, job: ImportProgress) => cb(job))
    },
    onDownloadProgress: (cb: (state: DownloadProgress) => void) => {
      ipcRenderer.on('download:progress', (_event, state: DownloadProgress) => cb(state))
    },
    onStreamProgress: (cb: (state: StreamProgress) => void) => {
      ipcRenderer.on('stream:progress', (_event, state: StreamProgress) => cb(state))
    },
    onLibraryChanged: (cb: () => void) => {
      ipcRenderer.on('library:changed', () => cb())
    },
    onThumb: (cb: (event: ThumbEvent) => void) => {
      ipcRenderer.on('library:thumb', (_event, event: ThumbEvent) => cb(event))
    }
  }
}

contextBridge.exposeInMainWorld('teleplayer', api)

export type {
  AppSettings,
  AuthState,
  BootstrapData,
  CacheInfo,
  DownloadProgress,
  FolderInput,
  ImportProgress,
  Library,
  PlaybackOpenResult,
  StreamProgress,
  ThumbEvent,
  WindowApi
}
