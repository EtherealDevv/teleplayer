import { app, BrowserWindow, Menu, nativeTheme, protocol, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { AppStore } from './store'
import type { TelegramService as TelegramServiceType } from './telegram'
import { registerIpc } from './ipc'
import { registerMediaProtocol, setMediaStreamHandler } from './protocol'

// cifrante's optional native addon crashes inside Electron's main process with
// the Windows build. teleproto works correctly with its portable WASM/JS
// backend, so force it before any TelegramClient is created.
process.env.CIFRANTE_NATIVE = '0'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'tp-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false
    }
  }
])

let mainWindow: BrowserWindow | null = null
let store: AppStore | null = null
let telegram: TelegramServiceType | null = null

const screenshotMode = process.argv.includes('--screenshot')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    app.setAppUserModelId('app.teleplayer.desktop')

    store = new AppStore()
    registerMediaProtocol(store)

    const window = createWindow()
    mainWindow = window

    const { TelegramService } = await import('./telegram')
    telegram = new TelegramService(store, {
      auth: (state) => send('auth:changed', state),
      importProgress: (job) => send('import:progress', job),
      downloadProgress: (state) => send('download:progress', state),
      streamProgress: (state) => send('stream:progress', state),
      libraryChanged: () => send('library:changed'),
      thumb: (event) => send('library:thumb', event)
    })
    setMediaStreamHandler((videoId, request) => telegram!.serveMedia(videoId, request))

    registerIpc(store, telegram, () => mainWindow)
    void telegram.bootstrap()

    if (screenshotMode) {
      window.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const image = await window.webContents.capturePage()
            const output = path.join(process.cwd(), 'teleplayer-screenshot.png')
            fs.writeFileSync(output, image.toPNG())
            console.log('Screenshot saved to', output)
          } catch (error) {
            console.error('Could not capture screenshot', error)
          } finally {
            app.quit()
          }
        }, 2200)
      })
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
}

function send(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function createWindow(): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), 'resources', 'icon.ico')
  const dark =
    store?.settings.themeMode === 'dark' ||
    (store?.settings.themeMode !== 'light' && nativeTheme.shouldUseDarkColors)
  const chromeColor = dark ? '#212121' : '#ffffff'
  const chromeSymbol = dark ? '#f5f5f5' : '#1a1a1a'
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    title: 'TelePlayer',
    backgroundColor: chromeColor,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: chromeColor, symbolColor: chromeSymbol, height: 44 }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {
      // Ignore malformed URLs.
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    try {
      const target = new URL(url)
      if (target.protocol === 'file:') return
    } catch {
      // Malformed navigation targets are always blocked.
    }
    event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}
