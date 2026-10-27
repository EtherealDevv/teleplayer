import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  DownloadProgress,
  Folder,
  ImportProgress,
  Library,
  StreamProgress,
  VideoItem
} from '../../../shared/types'
import { api } from '../api'
import {
  cleanError,
  cx,
  formatBytes,
  formatDuration,
  normalizeSearch,
  progressPercent
} from '../utils'
import type { ToastTone } from './Toast'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'
import { MoveDialog } from './MoveDialog'
import { TextPromptDialog } from './TextPromptDialog'
import { VideoCard } from './VideoCard'

type SortMode = 'recent' | 'title' | 'size' | 'duration'

interface LibraryViewProps {
  library: Library
  folderId: string
  query: string
  loading: boolean
  imports: Record<string, ImportProgress>
  downloads: Record<string, DownloadProgress>
  streams: Record<string, StreamProgress>
  onPlay: (video: VideoItem) => void
  onImport: () => void
  onRefresh: (silent?: boolean) => Promise<void>
  onClearQuery: () => void
  onToast: (message: string, tone?: ToastTone) => void
}

const SORTS: Array<{ id: SortMode; label: string; icon: string }> = [
  { id: 'recent', label: 'Más recientes', icon: 'schedule' },
  { id: 'title', label: 'Título A–Z', icon: 'sort_by_alpha' },
  { id: 'size', label: 'Tamaño', icon: 'data_usage' },
  { id: 'duration', label: 'Duración', icon: 'timer' }
]

export function LibraryView({
  library,
  folderId,
  query,
  loading,
  imports,
  downloads,
  streams,
  onPlay,
  onImport,
  onRefresh,
  onClearQuery,
  onToast
}: LibraryViewProps): JSX.Element {
  const [sort, setSort] = useState<SortMode>('recent')
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [moveTarget, setMoveTarget] = useState<VideoItem | null>(null)
  const [renameTarget, setRenameTarget] = useState<VideoItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<VideoItem | null>(null)
  const [busy, setBusy] = useState(false)

  const activeFolder = library.folders.find((folder) => folder.id === folderId)
  const normalizedQuery = normalizeSearch(query)
  const searching = normalizedQuery.length > 0
  const folderTitle =
    folderId === 'all'
      ? 'Biblioteca'
      : folderId === 'none'
        ? 'Sin carpeta'
        : activeFolder?.name ?? 'Carpeta'

  const folderVideos = useMemo(() => {
    if (searching) return library.videos
    if (folderId === 'all') return library.videos
    if (folderId === 'none') return library.videos.filter((video) => !video.folderId)
    return library.videos.filter((video) => video.folderId === folderId)
  }, [library.videos, folderId, searching])

  const visibleVideos = useMemo(() => {
    const filtered = normalizedQuery
      ? folderVideos.filter(
          (video) =>
            normalizeSearch(video.title).includes(normalizedQuery) ||
            normalizeSearch(video.name).includes(normalizedQuery)
        )
      : folderVideos
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      switch (sort) {
        case 'title':
          return a.title.localeCompare(b.title, 'es')
        case 'size':
          return b.size - a.size
        case 'duration':
          return (b.duration ?? 0) - (a.duration ?? 0)
        default:
          return b.addedAt - a.addedAt
      }
    })
    return sorted
  }, [folderVideos, normalizedQuery, sort])

  const continueVideo = useMemo(() => {
    const inScope = (video: VideoItem): boolean => {
      if (folderId === 'all') return true
      if (folderId === 'none') return !video.folderId
      return video.folderId === folderId
    }
    return library.videos
      .filter(
        (video) =>
          inScope(video) &&
          video.watchPosition &&
          video.watchDuration &&
          video.watchPosition > 5 &&
          video.watchPosition < video.watchDuration * 0.95
      )
      .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))[0]
  }, [library.videos, folderId])

  const continueFolder = continueVideo?.folderId
    ? library.folders.find((folder) => folder.id === continueVideo.folderId)
    : undefined

  const activeImports = Object.values(imports).filter(
    (job) => job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled'
  ).length

  const totalVisibleSize = visibleVideos.reduce((sum, video) => sum + video.size, 0)
  const showContinue = Boolean(continueVideo) && !searching

  useEffect(() => {
    if (!sortOpen) return
    const close = (event: MouseEvent): void => {
      if (sortRef.current && !sortRef.current.contains(event.target as Node)) setSortOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [sortOpen])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [folderId, searching, sort])

  const moveVideo = async (targetFolderId: string | null): Promise<void> => {
    if (!moveTarget) return
    try {
      await api.library.moveVideo(moveTarget.id, targetFolderId)
      await onRefresh(true)
      onToast('Vídeo movido de carpeta.', 'success')
    } catch (caught) {
      onToast(cleanError(caught), 'error')
      throw caught
    }
  }

  const renameVideo = async (title: string): Promise<void> => {
    if (!renameTarget) return
    try {
      await api.library.renameVideo(renameTarget.id, title)
      await onRefresh(true)
      onToast('Título actualizado.', 'success')
    } catch (caught) {
      onToast(cleanError(caught), 'error')
      throw caught
    }
  }

  const deleteVideo = async (): Promise<void> => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await api.library.deleteVideo(deleteTarget.id)
      await onRefresh(true)
      onToast('Vídeo eliminado de Telegram.', 'success')
      setDeleteTarget(null)
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    } finally {
      setBusy(false)
    }
  }

  const downloadVideo = async (video: VideoItem): Promise<void> => {
    if (video.cached) {
      onToast('Este vídeo ya está en tu PC. Ábrelo desde el menú del vídeo.', 'info')
      return
    }
    if (downloads[video.id]?.status === 'downloading') {
      onToast('Este vídeo ya se está descargando.', 'info')
      return
    }
    try {
      await api.playback.download(video.id)
      onToast('Descargando desde Telegram. Puedes seguir usando la app.', 'info')
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    }
  }

  const openExternal = async (video: VideoItem): Promise<void> => {
    try {
      onToast(video.cached ? 'Abriendo el vídeo…' : 'Descargando y abriendo el vídeo…', 'info')
      await api.playback.openExternal(video.id)
      await onRefresh(true)
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    }
  }

  const reveal = (video: VideoItem): void => {
    void api.playback.reveal(video.id)
  }

  const headerIcon = searching ? (
    <Icon name="search" size={21} />
  ) : folderId === 'all' ? (
    <Icon name="movie" filled size={21} />
  ) : folderId === 'none' ? (
    <Icon name="inbox" size={20} />
  ) : (
    activeFolder?.emoji ?? '🎬'
  )
  const headerClass = cx(
    'library-cover',
    searching && 'search',
    folderId === 'all' && !searching && 'all',
    folderId === 'none' && !searching && 'unfiled'
  )

  return (
    <div className="library-view">
      <header className="library-header">
        <span
          className={headerClass}
          style={
            activeFolder && !searching && folderId !== 'all' && folderId !== 'none'
              ? ({ '--folder-color': activeFolder.color } as CSSProperties)
              : undefined
          }
        >
          {headerIcon}
        </span>
        <div className="library-heading">
          <h1>{searching ? 'Búsqueda' : folderTitle}</h1>
          <p>
            {searching
              ? `${visibleVideos.length} ${
                  visibleVideos.length === 1 ? 'resultado' : 'resultados'
                } para «${query.trim()}»`
              : `${visibleVideos.length} ${
                  visibleVideos.length === 1 ? 'vídeo' : 'vídeos'
                } · ${formatBytes(totalVisibleSize)}`}
          </p>
        </div>

        <div className="library-actions">
          {searching ? (
            <button className="icon-btn" onClick={onClearQuery} title="Borrar búsqueda" aria-label="Borrar búsqueda">
              <Icon name="close" size={21} />
            </button>
          ) : null}
          <div className="sort-wrap" ref={sortRef}>
            <button
              className={cx('icon-btn', sortOpen && 'active')}
              onClick={() => setSortOpen((value) => !value)}
              aria-label="Ordenar vídeos"
              title="Ordenar"
            >
              <Icon name="sort" size={21} />
            </button>
            {sortOpen ? (
              <div className="sort-menu">
                {SORTS.map((option) => (
                  <button
                    key={option.id}
                    className={sort === option.id ? 'selected' : ''}
                    onClick={() => {
                      setSort(option.id)
                      setSortOpen(false)
                    }}
                  >
                    <Icon name={option.icon} size={19} />
                    <span>{option.label}</span>
                    {sort === option.id ? <Icon name="check" size={18} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className={cx('icon-btn', loading && 'spinning')}
            onClick={() => void onRefresh()}
            aria-label="Actualizar biblioteca"
            title="Actualizar"
            disabled={loading}
          >
            <Icon name="refresh" size={21} />
          </button>
          <button className="icon-btn header-add" onClick={onImport} title="Añadir vídeos" aria-label="Añadir vídeos">
            <Icon name="add" size={22} />
            {activeImports > 0 ? <span className="header-add-count">{activeImports}</span> : null}
          </button>
        </div>
      </header>

      <div className="library-scroll" ref={scrollRef}>
        {showContinue && continueVideo ? (
          <button className="continue-card" onClick={() => onPlay(continueVideo)}>
            <div
              className="continue-thumb"
              style={
                continueVideo.thumbUrl
                  ? { backgroundImage: `url("${continueVideo.thumbUrl}")` }
                  : undefined
              }
            >
              {!continueVideo.thumbUrl ? <Icon name="movie" size={24} /> : null}
              <span className="continue-play">
                <Icon name="play_arrow" filled size={20} />
              </span>
            </div>
            <div className="continue-copy">
              <span className="continue-label">
                <Icon name="push_pin" size={13} /> Continuar viendo
              </span>
              <strong>{continueVideo.title}</strong>
              <span className="continue-meta">
                {continueFolder ? `${continueFolder.emoji} ${continueFolder.name} · ` : ''}
                Te quedan{' '}
                {formatDuration(
                  Math.max(
                    0,
                    (continueVideo.watchDuration ?? 0) - (continueVideo.watchPosition ?? 0)
                  )
                )}
              </span>
              <div className="continue-progress">
                <span
                  style={{
                    width: `${progressPercent(
                      continueVideo.watchPosition ?? 0,
                      continueVideo.watchDuration ?? 0
                    )}%`
                  }}
                />
              </div>
            </div>
            <span className="continue-cta">
              <Icon name="play_arrow" filled size={20} />
            </span>
          </button>
        ) : null}

        {visibleVideos.length > 0 || loading ? (
          <div className="library-summary">
            <span>
              {visibleVideos.length} {visibleVideos.length === 1 ? 'vídeo' : 'vídeos'}
            </span>
            <span className="dot-sep">·</span>
            <span>{formatBytes(totalVisibleSize)}</span>
            {folderId === 'all' && !searching ? (
              <>
                <span className="dot-sep">·</span>
                <span className="library-private">
                  <Icon name="lock" size={13} /> Solo tú
                </span>
              </>
            ) : null}
            <div className="library-summary-spacer" />
            <button className="btn text small" onClick={onImport}>
              <Icon name="add" size={17} /> Añadir vídeos
            </button>
          </div>
        ) : null}

        {loading && library.videos.length === 0 ? (
          <div className="video-grid skeleton-grid">
            {Array.from({ length: 8 }).map((_, index) => (
              <div className="video-skeleton" key={index}>
                <div className="skeleton-cover" />
                <div className="skeleton-line wide" />
                <div className="skeleton-line" />
              </div>
            ))}
          </div>
        ) : visibleVideos.length > 0 ? (
          <div className="video-grid">
            {visibleVideos.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                folder={
                  video.folderId
                    ? library.folders.find((folder) => folder.id === video.folderId)
                    : undefined
                }
                download={downloads[video.id]}
                stream={streams[video.id]}
                onPlay={onPlay}
                onMove={setMoveTarget}
                onRename={setRenameTarget}
                onDelete={setDeleteTarget}
                onDownload={(item) => void downloadVideo(item)}
                onOpenExternal={(item) => void openExternal(item)}
                onReveal={reveal}
              />
            ))}
          </div>
        ) : searching ? (
          <div className="empty-state">
            <div className="empty-orbit search">
              <Icon name="search_off" size={38} />
            </div>
            <h2>Sin resultados para «{query.trim()}»</h2>
            <p>Prueba con otro título o borra la búsqueda para ver todos tus vídeos.</p>
            <button className="btn tonal" onClick={onClearQuery}>
              Borrar búsqueda
            </button>
          </div>
        ) : folderId !== 'all' ? (
          <div className="empty-state">
            <div className="empty-orbit folder">
              <Icon name="folder_open" size={38} />
            </div>
            <h2>{folderId === 'none' ? 'No hay vídeos sin carpeta' : 'Esta carpeta está vacía'}</h2>
            <p>
              {folderId === 'none'
                ? 'Los vídeos que no asignes a una carpeta aparecerán aquí. También puedes añadir vídeos nuevos.'
                : 'Añade vídeos nuevos o mueve alguno desde otra carpeta. Lo que ves aquí también está en Telegram.'}
            </p>
            <div className="empty-actions">
              <button className="btn filled" onClick={onImport}>
                <Icon name="add" size={19} /> Añadir vídeos
              </button>
              <button className="btn text" onClick={() => void onRefresh()}>
                Actualizar
              </button>
            </div>
          </div>
        ) : (
          <div className="empty-state library-empty">
            <div className="empty-orbit library">
              <Icon name="movie" filled size={38} />
            </div>
            <h2>Tu videoteca empieza aquí</h2>
            <p>
              Añade tu primer vídeo y TelePlayer lo guardará en tu canal privado de Telegram. Sin
              cuotas, sin perder calidad y con soporte para archivos de más de 2 GB.
            </p>
            <button className="btn filled lg" onClick={onImport}>
              <Icon name="add_to_photos" size={20} /> Añadir mi primer vídeo
            </button>
            <span className="empty-hint">
              <Icon name="lock" size={15} /> Solo tú puedes acceder a este canal
            </span>
          </div>
        )}
      </div>

      <MoveDialog
        open={Boolean(moveTarget)}
        video={moveTarget}
        folders={library.folders}
        currentFolderId={moveTarget?.folderId ?? null}
        onClose={() => setMoveTarget(null)}
        onMove={moveVideo}
      />

      <TextPromptDialog
        open={Boolean(renameTarget)}
        title="Cambiar título"
        label="Título del vídeo"
        description="El nuevo título se guarda en Telegram y se verá en todos tus dispositivos."
        icon="title"
        initialValue={renameTarget?.title ?? ''}
        onSubmit={renameVideo}
        onClose={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Eliminar vídeo de Telegram"
        message={`Se borrarán todas las partes de «${deleteTarget?.title ?? ''}» del canal y la copia local. Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar definitivamente"
        danger
        busy={busy}
        onConfirm={() => void deleteVideo()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
