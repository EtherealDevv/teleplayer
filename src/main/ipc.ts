import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  systemPreferences
} from 'electron'
import type { OpenDialogOptions } from 'electron'
import type { AppSettings, BootstrapData, CacheInfo, Library } from '../shared/types'
import type { AppStore } from './store'
import type { TelegramService } from './telegram'
import { errorText } from './errors'
import { detectCountry } from './locale'

type Handler = (...args: any[]) => Promise<unknown> | unknown

function accentColor(): string {
  try {
    const raw = systemPreferences.getAccentColor()
    if (/^[0-9a-f]{6,8}$/i.test(raw)) return `#${raw.slice(0, 6)}`
  } catch {
    // Not available on every platform.
  }
  return '#3390EC'
}

export function registerIpc(
  store: AppStore,
  telegram: TelegramService,
  getWindow: () => BrowserWindow | null
): void {
  const handle = (channel: string, handler: Handler): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(...args)
      } catch (error) {
        throw new Error(errorText(error))
      }
    })
  }

  handle('app:bootstrap', (): BootstrapData => ({
    settings: store.settings,
    auth: telegram.state,
    library: null,
    appVersion: app.getVersion(),
    accentColor: accentColor(),
    detectedCountry: detectCountry()
  }))

  handle('settings:update', (patch: Partial<AppSettings>): AppSettings => {
    return store.updateSettings(patch ?? {})
  })

  handle('app:set-titlebar', (colors: { color?: string; symbolColor?: string }): void => {
    const win = getWindow()
    if (!win || process.platform !== 'win32') return
    const color = /^#[0-9a-f]{6}$/i.test(colors?.color ?? '') ? colors.color! : '#212121'
    const symbolColor = /^#[0-9a-f]{6}$/i.test(colors?.symbolColor ?? '')
      ? colors.symbolColor!
      : '#ffffff'
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 44 })
    } catch {
      // Window controls are cosmetic.
    }
  })

  handle('app:open-external', async (url: unknown): Promise<void> => {
    const target = String(url ?? '')
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new Error('El enlace no es válido.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Solo se pueden abrir enlaces web.')
    }
    await shell.openExternal(parsed.toString())
  })

  handle('auth:configure', (apiId: string, apiHash: string) =>
    telegram.configure(apiId, apiHash)
  )
  handle('auth:send-code', (phone: string) => telegram.sendCode(phone))
  handle('auth:sign-in', (code: string) => telegram.signIn(code))
  handle('auth:password', (password: string) => telegram.password(password))
  handle('auth:reconnect', () => telegram.reconnect())
  handle('auth:logout', () => telegram.logout())
  handle('auth:reset-credentials', () => telegram.resetCredentials())
  handle('auth:state', () => telegram.state)

  handle('library:refresh', (): Promise<Library> => telegram.listLibrary())

  handle(
    'library:import-dialog',
    async (folderId: string | null): Promise<{ cancelled: boolean; count: number }> => {
      const win = getWindow()
      const options: OpenDialogOptions = {
        title: 'Añadir vídeos a TelePlayer',
        defaultPath: app.getPath('videos'),
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Vídeos',
            extensions: [
              'mp4',
              'm4v',
              'mov',
              'mkv',
              'webm',
              'avi',
              'wmv',
              'flv',
              'mpg',
              'mpeg',
              'ts',
              'm2ts',
              '3gp',
              'ogv'
            ]
          },
          { name: 'Todos los archivos', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true, count: 0 }
      }
      const count = telegram.queueImport(result.filePaths, folderId ?? null)
      return { cancelled: false, count }
    }
  )

  handle('library:delete-video', (videoId: string) => telegram.deleteVideo(videoId))
  handle('library:move-video', (videoId: string, folderId: string | null) =>
    telegram.moveVideo(videoId, folderId)
  )
  handle('library:rename-video', (videoId: string, title: string) =>
    telegram.renameVideo(videoId, title)
  )
  handle('library:thumb', (videoId: string) => telegram.thumb(videoId))

  handle('folder:create', (input) => telegram.createFolder(input))
  handle('folder:rename', (folderId: string, input) => telegram.renameFolder(folderId, input))
  handle('folder:delete', (folderId: string) => telegram.deleteFolder(folderId))

  handle('library:cache-info', (): CacheInfo => telegram.cacheInfo())
  handle('library:clear-cache', (): Promise<CacheInfo> => telegram.clearCache())
  handle('library:open-cache-folder', async (): Promise<void> => {
    await shell.openPath(store.cacheDir)
  })

  handle('playback:open', (videoId: string) => telegram.open(videoId))
  handle('playback:status', (videoId: string) => telegram.status(videoId))
  handle('playback:stream-status', (videoId: string) => telegram.streamStatus(videoId))
  handle('playback:url', (videoId: string) => telegram.url(videoId))
  handle('playback:cancel', (videoId: string) => telegram.cancelDownload(videoId))
  handle('playback:download', (videoId: string) => telegram.download(videoId))
  handle('playback:set-active', (videoId: string | null) => {
    telegram.setActivePlayback(videoId)
  })
  handle('playback:save-progress', (videoId: string, position: number, duration: number) => {
    telegram.saveProgress(videoId, Number(position), Number(duration))
  })
  handle('playback:open-external', (videoId: string) => telegram.openExternal(videoId))
  handle('playback:reveal', (videoId: string) => {
    const file = store.getCacheFile(videoId)
    if (file) shell.showItemInFolder(file)
  })
}
