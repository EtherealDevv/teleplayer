import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DownloadProgress, Folder, StreamProgress, VideoItem } from '../../../shared/types'
import { cx, formatBytes, formatDuration, formatPercent, formatRelative, idHue, progressPercent } from '../utils'
import { Icon } from './Icon'

interface VideoCardProps {
  video: VideoItem
  folder?: Folder
  download?: DownloadProgress
  stream?: StreamProgress
  onPlay: (video: VideoItem) => void
  onMove: (video: VideoItem) => void
  onRename: (video: VideoItem) => void
  onDelete: (video: VideoItem) => void
  onDownload: (video: VideoItem) => void
  onOpenExternal: (video: VideoItem) => void
  onReveal: (video: VideoItem) => void
}

export function VideoCard({
  video,
  folder,
  download,
  stream,
  onPlay,
  onMove,
  onRename,
  onDelete,
  onDownload,
  onOpenExternal,
  onReveal
}: VideoCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAbove, setMenuAbove] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const progress =
    video.watchDuration && video.watchDuration > 0
      ? progressPercent(video.watchPosition ?? 0, video.watchDuration)
      : 0
  const downloading = download?.status === 'downloading'
  const downloadPercent = download
    ? progressPercent(download.downloadedBytes, download.totalBytes)
    : 0
  const streaming =
    !video.cached &&
    stream?.status === 'streaming' &&
    stream.cachedBytes > 0
  const streamPercent = stream
    ? progressPercent(stream.cachedBytes, stream.totalBytes)
    : 0

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  useLayoutEffect(() => {
    if (!menuOpen) return
    const card = cardRef.current
    const menu = menuRef.current
    if (!card || !menu) return
    const cardRect = card.getBoundingClientRect()
    const scroll = card.closest('.library-scroll') as HTMLElement | null
    const scrollRect = scroll?.getBoundingClientRect()
    const viewportTop = scrollRect?.top ?? 0
    const viewportBottom = scrollRect?.bottom ?? window.innerHeight
    const belowSpace = viewportBottom - (cardRect.top + 42) - 12
    const aboveSpace = cardRect.bottom - 44 - viewportTop - 12
    setMenuAbove(belowSpace < menu.offsetHeight && aboveSpace > belowSpace)
  }, [menuOpen])

  const run = (action: () => void): void => {
    setMenuOpen(false)
    action()
  }

  return (
    <article
      ref={cardRef}
      className={cx('video-card', menuOpen && 'menu-open')}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button
        className="video-cover"
        onClick={() => onPlay(video)}
        aria-label={`Reproducir ${video.title}`}
      >
        <div
          className="cover-fallback"
          style={{
            background: `linear-gradient(135deg, hsl(${idHue(video.id)} 42% 34%), hsl(${
              (idHue(video.id) + 52) % 360
            } 38% 17%))`
          }}
        />
        {video.thumbUrl ? (
          <img
            className="cover-image"
            src={video.thumbUrl}
            alt=""
            loading="lazy"
            draggable={false}
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
          />
        ) : null}

        <div className="cover-shade" />

        <div className="cover-top">
          {video.parts > 1 ? (
            <span className="cover-chip">
              <Icon name="call_split" size={13} /> {video.parts} partes
            </span>
          ) : (
            <span />
          )}
          <span
            className="cover-cloud"
            title={video.cached ? 'Copiada en este PC' : 'Solo en Telegram'}
          >
            <Icon name={video.cached ? 'offline_pin' : 'cloud'} filled size={16} />
          </span>
        </div>

        <span className="card-play">
          <Icon name="play_arrow" filled size={28} />
        </span>

        <div className="cover-bottom">
          {video.cached ? <span className="cover-chip subtle">Local</span> : <span />}
          {video.duration ? (
            <span className="duration-chip">{formatDuration(video.duration)}</span>
          ) : null}
        </div>

        {progress > 0.5 ? (
          <div className="watch-progress">
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}

        {downloading ? (
          <div className="card-transfer">
            <div className="card-transfer-label">
              <span>Descargando · {formatPercent(downloadPercent)}%</span>
              <span>{formatBytes(download.speed)}/s</span>
            </div>
            <div className="card-transfer-bar">
              <span style={{ width: `${downloadPercent}%` }} />
            </div>
          </div>
        ) : streaming ? (
          <div className="card-transfer streaming">
            <div className="card-transfer-label">
              <span>
                <Icon name="cloud_download" size={13} /> En caché · {formatPercent(streamPercent)}%
              </span>
              <span>{formatBytes(stream.speed)}/s</span>
            </div>
            <div className="card-transfer-bar">
              <span style={{ width: `${streamPercent}%` }} />
            </div>
          </div>
        ) : null}
      </button>

      <div className="video-card-body">
        <button className="video-title" onClick={() => onPlay(video)} title={video.title}>
          {video.title}
        </button>
        <div className="video-meta">
          {folder ? (
            <span className="video-folder">
              <span className="tiny-emoji">{folder.emoji}</span>
              {folder.name}
            </span>
          ) : (
            <span className="video-folder muted">Sin carpeta</span>
          )}
          <span className="dot-sep">·</span>
          <span>{formatBytes(video.size)}</span>
          {video.watchPosition && progress > 0.5 && progress < 95 ? (
            <>
              <span className="dot-sep">·</span>
              <span className="resume-label">
                <Icon name="play_circle" size={13} /> {formatDuration(video.watchPosition)}
              </span>
            </>
          ) : null}
        </div>
        <div className="video-card-footer">
          <span className="video-status" title={video.cached ? 'Copia local disponible' : 'Guardado en Telegram'}>
            <Icon name={video.cached ? 'offline_pin' : 'cloud'} size={14} />
            {video.cached ? 'En este PC' : 'En Telegram'}
          </span>
          <span className="video-date">{formatRelative(video.addedAt)}</span>
          <button
            className="icon-btn card-menu-btn"
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen((value) => !value)
            }}
            aria-label="Opciones del vídeo"
          >
            <Icon name="more_vert" size={19} />
          </button>
        </div>
      </div>

      {menuOpen ? (
        <div
          ref={menuRef}
          className={cx('card-menu', menuAbove && 'above')}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => run(() => onPlay(video))}>
            <Icon name="play_arrow" size={19} /> Reproducir
          </button>
          <button onClick={() => run(() => onMove(video))}>
            <Icon name="drive_file_move" size={19} /> Mover a carpeta
          </button>
          <button onClick={() => run(() => onRename(video))}>
            <Icon name="edit" size={19} /> Cambiar título
          </button>
          {!video.cached && !downloading ? (
            <button onClick={() => run(() => onDownload(video))}>
              <Icon name="download" size={19} /> Descargar sin abrir
            </button>
          ) : null}
          {video.cached ? (
            <>
              <button onClick={() => run(() => onOpenExternal(video))}>
                <Icon name="open_in_new" size={19} /> Abrir con el reproductor
              </button>
              <button onClick={() => run(() => onReveal(video))}>
                <Icon name="folder_open" size={19} /> Mostrar en el explorador
              </button>
            </>
          ) : null}
          <div className="menu-divider" />
          <button className="danger-text" onClick={() => run(() => onDelete(video))}>
            <Icon name="delete" size={19} /> Eliminar de Telegram
          </button>
        </div>
      ) : null}
    </article>
  )
}
