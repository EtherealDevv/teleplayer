import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AuthState,
  BootstrapData,
  DownloadProgress,
  Folder,
  ImportProgress,
  Library,
  StreamProgress,
  VideoItem
} from '../../shared/types'
import type { ToastTone } from './components/Toast'
import { api } from './api'
import { applyTheme } from './theme'
import { cleanError } from './utils'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FolderDialog } from './components/FolderDialog'
import { ImportTray } from './components/ImportTray'
import { LibraryView } from './components/LibraryView'
import { Onboarding } from './components/Onboarding'
import { Player } from './components/Player'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { Splash } from './components/Splash'
import { Toast, type ToastData } from './components/Toast'
import { Icon } from './components/Icon'

type DialogState = { mode: 'create' } | { mode: 'edit'; folder: Folder }

export default function App(): JSX.Element {
  const [boot, setBoot] = useState<BootstrapData | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [library, setLibrary] = useState<Library | null>(null)
  const [libraryError, setLibraryError] = useState('')
  const [view, setView] = useState<'library' | 'settings'>('library')
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [query, setQuery] = useState('')
  const [player, setPlayer] = useState<VideoItem | null>(null)
  const [imports, setImports] = useState<Record<string, ImportProgress>>({})
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
  const [streams, setStreams] = useState<Record<string, StreamProgress>>({})
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<ToastData | null>(null)
  const [folderDialog, setFolderDialog] = useState<DialogState | null>(null)
  const [deleteFolder, setDeleteFolder] = useState<Folder | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [themeTick, setThemeTick] = useState(0)
  const [dropActive, setDropActive] = useState(false)

  const toastTimer = useRef<number | null>(null)
  const playerIdRef = useRef<string | null>(null)
  const loadingRef = useRef(false)
  const refreshQueuedRef = useRef(false)
  const authEventSeenRef = useRef(false)
  const importTimersRef = useRef(new Map<string, number>())
  const dragDepthRef = useRef(0)
  /** Páginas del historial cargadas: un refresco silencioso las vuelve a pedir. */
  const pagesLoadedRef = useRef(1)

  const showToast = useCallback((message: string, tone: ToastTone = 'info'): void => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), message, tone })
    toastTimer.current = window.setTimeout(() => setToast(null), 4600)
  }, [])

  const refreshLibrary = useCallback(
    async (silent = false): Promise<void> => {
      if (loadingRef.current) {
        if (silent) refreshQueuedRef.current = true
        return
      }
      loadingRef.current = true
      if (!silent) setLoading(true)
      try {
        let resolved = await api.library.refresh(silent)
        // Un refresco silencioso (importación terminada, descarga completada)
        // no debe devolver la biblioteca a la primera página: se vuelven a
        // pedir las mismas páginas que había abiertas. Después se resuelve
        // todo contra `resolved`, o el reproductor perdería un vídeo que vive
        // en una página ya cargada.
        const wanted = silent ? pagesLoadedRef.current : 1
        if (wanted > 1 && resolved.hasMore) {
          for (let page = 1; page < wanted && resolved.hasMore; page += 1) {
            resolved = await api.library.loadMore()
          }
        } else {
          pagesLoadedRef.current = 1
        }
        setLibrary(resolved)
        setLibraryError('')
        setSelectedFolder((current) => {
          if (current === 'all' || current === 'none') return current
          return resolved.folders.some((folder) => folder.id === current) ? current : 'all'
        })
        setPlayer((current) =>
          current ? resolved.videos.find((video) => video.id === current.id) ?? null : null
        )
      } catch (caught) {
        if (!silent) {
          const message = cleanError(caught)
          setLibraryError(message)
          showToast(message, 'error')
        }
      } finally {
        loadingRef.current = false
        if (!silent) setLoading(false)
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false
          void refreshLibrary(true)
        }
      }
    },
    [showToast]
  )

  const loadMoreLibrary = useCallback(async (): Promise<void> => {
    const next = await api.library.loadMore()
    pagesLoadedRef.current += 1
    setLibrary(next)
  }, [])

  useEffect(() => {
    playerIdRef.current = player?.id ?? null
  }, [player])

  useEffect(() => {
    api.events.onAuthChanged((state) => {
      authEventSeenRef.current = true
      setAuth(state)
      if (state.status !== 'authorized') {
        setLibrary(null)
        setLibraryError('')
        setPlayer(null)
        setView('library')
        setSelectedFolder('all')
        setQuery('')
        setImports({})
        setDownloads({})
        setStreams({})
      }
    })
    api.events.onImportProgress((job) => {
      setImports((current) => ({ ...current, [job.jobId]: job }))
    })
    api.events.onDownloadProgress((state) => {
      setDownloads((current) => ({ ...current, [state.videoId]: state }))
      if (state.status === 'done') {
        setLibrary((current) =>
          current
            ? {
                ...current,
                videos: current.videos.map((video) =>
                  video.id === state.videoId ? { ...video, cached: true } : video
                )
              }
            : current
        )
        if (playerIdRef.current !== state.videoId) {
          showToast('Vídeo descargado. Ya puedes reproducirlo sin cortes.', 'success')
        }
      } else if (state.status === 'error' && playerIdRef.current !== state.videoId) {
        showToast(state.error || 'No se pudo descargar el vídeo.', 'error')
      }
    })
    api.events.onStreamProgress((state) => {
      setStreams((current) => ({ ...current, [state.videoId]: state }))
      if (state.status === 'cached') {
        setLibrary((current) =>
          current
            ? {
                ...current,
                videos: current.videos.map((video) =>
                  video.id === state.videoId ? { ...video, cached: true } : video
                )
              }
            : current
        )
        setPlayer((current) =>
          current && current.id === state.videoId ? { ...current, cached: true } : current
        )
      } else if (state.status === 'error' && playerIdRef.current !== state.videoId) {
        showToast(state.error || 'No se pudo transmitir el vídeo.', 'error')
      }
    })
    api.events.onLibraryChanged(() => {
      void refreshLibrary(true)
    })
    api.events.onThumb((event) => {
      setLibrary((current) =>
        current
          ? {
              ...current,
              videos: current.videos.map((video) =>
                video.id === event.videoId
                  ? { ...video, thumbUrl: event.url, hasThumb: true }
                  : video
              )
            }
          : current
      )
    })
  }, [refreshLibrary, showToast])

  useEffect(() => {
    void loadBootstrap()
    async function loadBootstrap(): Promise<void> {
      const data = await api.bootstrap().catch((error) => {
        showToast(cleanError(error), 'error')
        return null
      })
      if (!data) return
      setBoot(data)
      setAuth((current) => (authEventSeenRef.current && current ? current : data.auth))
      setSettings(data.settings)
    }
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [showToast])

  useEffect(() => {
    if (auth?.status === 'authorized' && !library && !libraryError && !loadingRef.current) {
      void refreshLibrary()
    }
  }, [auth?.status, library, libraryError, refreshLibrary])

  // Las importaciones viven en el proceso principal: al abrir la app (o al
  // reconectar) la bandeja se rellena con lo que siga subiéndose o esperando.
  useEffect(() => {
    if (auth?.status !== 'authorized') return
    void api.library
      .imports()
      .then((jobs) => {
        if (jobs.length === 0) return
        setImports((current) => {
          const next = { ...current }
          for (const job of jobs) if (!next[job.jobId]) next[job.jobId] = job
          return next
        })
      })
      .catch(() => undefined)
  }, [auth?.status])

  useEffect(() => {
    if (!settings || !boot) return
    const result = applyTheme(settings, boot.accentColor)
    void api.setTitlebar(
      player
        ? { color: '#0f0f0f', symbolColor: '#ffffff' }
        : { color: result.surface, symbolColor: result.symbol }
    )
  }, [settings, boot, themeTick, player])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (): void => setThemeTick((value) => value + 1)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  useEffect(() => {
    const timers = importTimersRef.current
    const present = new Set(Object.keys(imports))
    for (const [jobId, timer] of timers) {
      if (!present.has(jobId)) {
        window.clearTimeout(timer)
        timers.delete(jobId)
      }
    }
    for (const job of Object.values(imports)) {
      if (job.status !== 'done') {
        const existing = timers.get(job.jobId)
        if (existing) {
          window.clearTimeout(existing)
          timers.delete(job.jobId)
        }
        continue
      }
      if (timers.has(job.jobId)) continue
      const timer = window.setTimeout(() => {
        timers.delete(job.jobId)
        setImports((current) => {
          const next = { ...current }
          delete next[job.jobId]
          return next
        })
      }, 9000)
      timers.set(job.jobId, timer)
    }
  }, [imports])

  useEffect(() => {
    const timers = importTimersRef.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await api.updateSettings(patch)
    setSettings(next)
  }, [])

  const selectFolder = useCallback((folderId: string): void => {
    setSelectedFolder(folderId)
    setQuery('')
    setView('library')
  }, [])

  const openSettings = useCallback((): void => {
    setQuery('')
    setView('settings')
  }, [])

  const changeQuery = useCallback((value: string): void => {
    setQuery(value)
    if (value.trim()) setView('library')
  }, [])

  const handleImport = async (): Promise<void> => {
    if (!auth || auth.status !== 'authorized') return
    const target =
      selectedFolder === 'all' || selectedFolder === 'none' ? null : selectedFolder
    try {
      const result = await api.library.importDialog(target)
      if (result.cancelled) return
      if (result.count === 0) {
        showToast('No se añadió nada: ya estaba en tu biblioteca o no es un vídeo compatible.', 'info')
      } else {
        showToast(
          result.count === 1
            ? 'Añadiendo vídeo a Telegram…'
            : `Añadiendo ${result.count} vídeos a Telegram…`,
          'info'
        )
      }
    } catch (caught) {
      showToast(cleanError(caught), 'error')
    }
  }

  const importTarget =
    selectedFolder === 'all' || selectedFolder === 'none' ? null : selectedFolder

  const describeBatch = useCallback(
    (batch: { videos: number; folders: number; ignored: number; duplicates: number }): void => {
      if (batch.videos === 0) {
        if (batch.duplicates > 0) {
          showToast(
            batch.duplicates === 1
              ? 'Ese vídeo ya está en tu biblioteca. No se ha vuelto a subir.'
              : `${batch.duplicates} vídeos ya estaban en tu biblioteca. No se han vuelto a subir.`,
            'info'
          )
        } else {
          showToast(
            batch.ignored > 0
              ? 'No se encontraron vídeos compatibles en lo que seleccionaste.'
              : 'No se añadió nada.',
            'info'
          )
        }
        return
      }
      const parts = [
        `${batch.videos} ${batch.videos === 1 ? 'vídeo en cola' : 'vídeos en cola'}`
      ]
      if (batch.folders > 0) {
        parts.push(
          `${batch.folders} ${batch.folders === 1 ? 'carpeta nueva' : 'carpetas nuevas'}`
        )
      }
      if (batch.duplicates > 0) {
        parts.push(
          `${batch.duplicates} ${batch.duplicates === 1 ? 'repetido' : 'repetidos'} omitido${
            batch.duplicates === 1 ? '' : 's'
          }`
        )
      }
      showToast(`${parts.join(' · ')}. Subiendo a Telegram…`, 'info')
    },
    [showToast]
  )

  const handleImportFolder = async (): Promise<void> => {
    if (!auth || auth.status !== 'authorized') return
    try {
      const result = await api.library.importFolderDialog(importTarget)
      if (result.cancelled) return
      describeBatch(result)
    } catch (caught) {
      showToast(cleanError(caught), 'error')
    }
  }

  const handleImportPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      if (paths.length === 0) return
      try {
        const result = await api.library.importPaths(paths, importTarget)
        describeBatch(result)
      } catch (caught) {
        showToast(cleanError(caught), 'error')
      }
    },
    [describeBatch, importTarget, showToast]
  )

  // Arrastrar y soltar en cualquier parte de la ventana. Electron ya no
  // expone `File.path`, así que la ruta se pide al preload (webUtils).
  useEffect(() => {
    if (auth?.status !== 'authorized') return
    const hasFiles = (event: DragEvent): boolean => {
      const types = event.dataTransfer?.types
      return Boolean(types && Array.from(types).includes('Files'))
    }
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDropActive(true)
    }
    const onDragLeave = (): void => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDropActive(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current = 0
      setDropActive(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files
        .map((file) => api.library.pathForFile(file))
        .filter((value): value is string => Boolean(value))
      if (paths.length === 0) {
        showToast('No se pudo leer la ruta de lo que soltaste. Usa «Añadir carpeta».', 'error')
        return
      }
      void handleImportPaths(paths)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      dragDepthRef.current = 0
      setDropActive(false)
    }
  }, [auth?.status, handleImportPaths, showToast])

  const saveFolder = async (input: { name: string; emoji: string; color: string }): Promise<void> => {
    if (!folderDialog) return
    if (folderDialog.mode === 'create') {
      const next = await api.library.createFolder(input)
      setLibrary(next)
      showToast('Carpeta creada en Telegram.', 'success')
    } else {
      const next = await api.library.renameFolder(folderDialog.folder.id, input)
      setLibrary(next)
      showToast('Carpeta actualizada.', 'success')
    }
  }

  const confirmDeleteFolder = async (): Promise<void> => {
    if (!deleteFolder) return
    setFolderBusy(true)
    try {
      const next = await api.library.deleteFolder(deleteFolder.id)
      setLibrary(next)
      if (selectedFolder === deleteFolder.id) setSelectedFolder('all')
      showToast('Carpeta eliminada. Sus vídeos siguen en la biblioteca.', 'success')
      setDeleteFolder(null)
    } catch (caught) {
      showToast(cleanError(caught), 'error')
    } finally {
      setFolderBusy(false)
    }
  }

  const openPlayer = (video: VideoItem): void => {
    setStreams((current) => {
      if (!current[video.id]) return current
      const next = { ...current }
      delete next[video.id]
      return next
    })
    setPlayer(video)
  }

  const closePlayer = (): void => {
    setPlayer(null)
    void refreshLibrary(true)
  }

  const cancelImport = useCallback(
    async (jobId: string): Promise<void> => {
      try {
        await api.library.cancelImport(jobId)
      } catch (caught) {
        showToast(cleanError(caught), 'error')
      }
    },
    [showToast]
  )

  const retryImport = useCallback(
    async (jobId: string): Promise<void> => {
      try {
        await api.library.retryImport(jobId)
        showToast('Subida de nuevo en cola.', 'info')
      } catch (caught) {
        showToast(cleanError(caught), 'error')
      }
    },
    [showToast]
  )

  const activeImports = Object.values(imports).filter(
    (job) => job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled'
  ).length

  const titlebarStatus =
    auth?.status === 'authorized'
      ? 'Conectado a Telegram'
      : auth?.status === 'connecting'
        ? 'Conectando…'
        : 'Sin conectar'

  const activeFolderName = library?.folders.find((folder) => folder.id === selectedFolder)?.name
  const titlebarContext =
    auth?.status !== 'authorized'
      ? 'Videoteca en Telegram'
      : view === 'settings'
        ? 'Ajustes'
        : query.trim()
          ? 'Búsqueda'
          : selectedFolder === 'all'
            ? 'Biblioteca'
            : selectedFolder === 'none'
              ? 'Sin carpeta'
              : activeFolderName ?? 'Biblioteca'
  const titlebarTitle = player ? player.title : titlebarContext

  const titlebar = (
    <header className="app-titlebar">
      <span className="titlebar-title" title={titlebarTitle}>
        {titlebarTitle}
      </span>
      <div className="titlebar-spacer" />
      {auth?.status === 'authorized' ? (
        <span className="titlebar-status">
          <span className="status-dot" /> {titlebarStatus}
        </span>
      ) : (
        <span className="titlebar-status muted">{titlebarStatus}</span>
      )}
    </header>
  )

  if (!boot || !auth || !settings) {
    return (
      <div className="app-frame">
        {titlebar}
        <Splash />
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    )
  }

  if (auth.status === 'connecting') {
    return (
      <div className="app-frame">
        {titlebar}
        <Splash message="Conectando con tu Telegram…" />
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    )
  }

  if (auth.status !== 'authorized') {
    return (
      <div className="app-frame">
        {titlebar}
        <Onboarding
          auth={auth}
          detectedCountry={boot.detectedCountry}
          onAuth={setAuth}
        />
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    )
  }

  if (!library) {
    return (
      <div className="app-frame">
        {titlebar}
        {libraryError ? (
          <div className="fatal-screen">
            <div className="big-status-icon error">
              <Icon name="cloud_off" size={38} />
            </div>
            <h1>No pudimos abrir tu biblioteca</h1>
            <p>{libraryError}</p>
            <div className="fatal-actions">
              <button className="btn filled" onClick={() => void refreshLibrary()}>
                <Icon name="refresh" size={19} /> Reintentar
              </button>
              <button
                className="btn text"
                onClick={() =>
                  void api.auth
                    .logout()
                    .catch((error) => showToast(cleanError(error), 'error'))
                }
              >
                Cerrar sesión
              </button>
            </div>
          </div>
        ) : (
          <Splash message="Abriendo tu biblioteca en Telegram…" />
        )}
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    )
  }

  return (
    <div className={`app-frame${player ? ' player-open' : ''}`}>
      {titlebar}
      <div className="app-body">
        <Sidebar
          library={library}
          selectedFolder={selectedFolder}
          view={view}
          importing={activeImports}
          query={query}
          onQueryChange={changeQuery}
          onSelectFolder={selectFolder}
          onOpenLibrary={() => setView('library')}
          onOpenSettings={openSettings}
          onImport={() => void handleImport()}
          onImportFolder={() => void handleImportFolder()}
          onCreateFolder={() => setFolderDialog({ mode: 'create' })}
          onEditFolder={(folder) => setFolderDialog({ mode: 'edit', folder })}
          onDeleteFolder={setDeleteFolder}
        />

        <main className="main-content">
          {view === 'settings' ? (
            <SettingsView
              settings={settings}
              auth={auth}
              library={library}
              accentColor={boot.accentColor}
              appVersion={boot.appVersion}
              onSettingsChange={updateSettings}
              onRefresh={refreshLibrary}
              onToast={showToast}
              onBack={() => setView('library')}
            />
          ) : (
            <LibraryView
              library={library}
              folderId={selectedFolder}
              query={query}
              loading={loading}
              imports={imports}
              downloads={downloads}
              streams={streams}
              onPlay={openPlayer}
              onImport={() => void handleImport()}
              onImportFolder={() => void handleImportFolder()}
              onRefresh={refreshLibrary}
              onLoadMore={loadMoreLibrary}
              onClearQuery={() => setQuery('')}
              onToast={showToast}
            />
          )}
        </main>
      </div>

      {player ? (
        <Player
          video={player}
          folders={library.folders}
          download={downloads[player.id]}
          stream={streams[player.id]}
          onClose={closePlayer}
          onChanged={() => refreshLibrary(true)}
          onDeleted={() => {
            setPlayer(null)
            void refreshLibrary(true)
          }}
          onToast={showToast}
        />
      ) : null}

      <ImportTray
        jobs={imports}
        onCancel={(jobId) => void cancelImport(jobId)}
        onRetry={(jobId) => void retryImport(jobId)}
        onDismiss={(jobId) =>
          setImports((current) => {
            const next = { ...current }
            delete next[jobId]
            return next
          })
        }
      />

      {dropActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <span className="drop-icon">
              <Icon name="move_to_inbox" size={40} />
            </span>
            <h2>Suelta para añadir</h2>
            <p>
              Los vídeos sueltos van a la carpeta actual. Cada carpeta se convierte en una carpeta
              de tu biblioteca con su contenido.
            </p>
          </div>
        </div>
      ) : null}

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      <FolderDialog
        open={Boolean(folderDialog)}
        mode={folderDialog?.mode ?? 'create'}
        folder={folderDialog?.mode === 'edit' ? folderDialog.folder : null}
        onClose={() => setFolderDialog(null)}
        onSave={saveFolder}
      />

      <ConfirmDialog
        open={Boolean(deleteFolder)}
        title="Eliminar carpeta"
        message={`La carpeta «${deleteFolder?.name ?? ''}» se eliminará de Telegram. Sus vídeos no se borran: se moverán a «Sin carpeta».`}
        confirmLabel="Eliminar carpeta"
        danger
        busy={folderBusy}
        onConfirm={() => void confirmDeleteFolder()}
        onClose={() => setDeleteFolder(null)}
      />
    </div>
  )
}
