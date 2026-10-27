import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { DownloadProgress, Folder, StreamProgress, VideoItem } from '../../../shared/types'
import { api } from '../api'
import { cleanError, formatBytes, formatDuration, formatPercent, formatSpeed, formatTimecode, progressPercent } from '../utils'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'
import { MoveDialog } from './MoveDialog'
import type { ToastTone } from './Toast'

interface PlayerProps {
  video: VideoItem
  folders: Folder[]
  download?: DownloadProgress
  stream?: StreamProgress
  onClose: () => void
  onChanged: () => Promise<void>
  onDeleted: () => void
  onToast: (message: string, tone?: ToastTone) => void
}

type Phase = 'loading' | 'downloading' | 'ready' | 'error' | 'cancelled'

const PLAYBACK_RATES: number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const PLAYBACK_RATE_KEY = 'teleplayer-playback-rate'

function formatPlaybackRate(rate: number): string {
  return `${rate}×`
}

export function Player({
  video,
  folders,
  download,
  stream,
  onClose,
  onChanged,
  onDeleted,
  onToast
}: PlayerProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [downloadState, setDownloadState] = useState<DownloadProgress | null>(download ?? null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(video.duration ?? 0)
  const [volume, setVolume] = useState(() => {
    const saved = Number(window.localStorage.getItem('teleplayer-volume'))
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.9
  })
  const [playbackRate, setPlaybackRate] = useState(() => {
    const saved = Number(window.localStorage.getItem(PLAYBACK_RATE_KEY))
    return PLAYBACK_RATES.includes(saved) ? saved : 1
  })
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resumeNotice, setResumeNotice] = useState<number | null>(null)
  const [externalBusy, setExternalBusy] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [slowBuffer, setSlowBuffer] = useState(false)
  const [bufferAhead, setBufferAhead] = useState(0)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const screenRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const speedRef = useRef<HTMLDivElement | null>(null)
  const lastSaveRef = useRef(0)
  const resumeAppliedRef = useRef(false)
  const hideTimerRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const resolveUrl = useCallback(async (): Promise<void> => {
    try {
      const url = await api.playback.url(video.id)
      if (!url) return
      setSrc(url)
      setPhase('ready')
    } catch {
      // The polling fallback will try again while the player is open.
    }
  }, [video.id])

  useEffect(() => {
    let alive = true
    setPhase('loading')
    setSrc(null)
    setError('')
    setDownloadState(download ?? null)
    setBuffering(false)
    setSlowBuffer(false)
    setBufferAhead(0)
    setSpeedOpen(false)
    resumeAppliedRef.current = false
    void (async () => {
      try {
        const result = await api.playback.open(video.id)
        if (!alive) return
        if (result.state) setDownloadState(result.state)
        if (result.url) {
          setSrc(result.url)
          setPhase('ready')
        } else {
          setPhase('downloading')
        }
      } catch (caught) {
        if (!alive) return
        setError(cleanError(caught))
        setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [video.id])

  useEffect(() => {
    void api.playback.setActive(video.id)
    return () => {
      void api.playback.setActive(null)
    }
  }, [video.id])

  useEffect(() => {
    if (!download || download.videoId !== video.id) return
    setDownloadState(download)
    if (download.status === 'done') {
      void resolveUrl()
    } else if (download.status === 'error') {
      if (!src) {
        setError(download.error || 'No se pudo descargar el vídeo.')
        setPhase('error')
      }
    } else if (download.status === 'cancelled') {
      if (!src) setPhase('cancelled')
    } else if (!src) {
      setPhase('downloading')
    }
  }, [download, video.id, resolveUrl, src])

  useEffect(() => {
    if (!video.cached && stream?.status === 'error') {
      setError(stream.error || 'No se pudo transmitir el vídeo desde Telegram.')
      setPhase('error')
    }
  }, [stream, video.cached])

  useEffect(() => {
    if (phase !== 'downloading' && phase !== 'loading' && phase !== 'cancelled') return
    let alive = true
    const timer = window.setInterval(async () => {
      try {
        const state = await api.playback.status(video.id)
        if (!alive) return
        if (state) setDownloadState(state)
        if (state?.status === 'error') {
          setError(state.error || 'No se pudo descargar el vídeo.')
          setPhase('error')
          return
        }
        if (state?.status === 'cancelled') {
          setPhase('cancelled')
          return
        }
        const url = await api.playback.url(video.id)
        if (alive && url) {
          setSrc(url)
          setPhase('ready')
          return
        }
        if (phase === 'cancelled' && state?.status === 'downloading') setPhase('downloading')
      } catch {
        // Keep waiting; a transient error is handled by the download event.
      }
    }, 900)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [phase, video.id])

  useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement) return
    videoElement.volume = volume
    videoElement.muted = muted
  }, [volume, muted])

  useEffect(() => {
    const videoElement = videoRef.current
    if (videoElement) videoElement.playbackRate = playbackRate
  }, [playbackRate, phase, src])

  const applyPlaybackRate = useCallback((next: number): void => {
    setPlaybackRate(next)
    window.localStorage.setItem(PLAYBACK_RATE_KEY, String(next))
    const videoElement = videoRef.current
    if (videoElement) videoElement.playbackRate = next
    setControlsVisible(true)
  }, [])

  const shiftPlaybackRate = useCallback(
    (direction: number): void => {
      const currentIndex = PLAYBACK_RATES.indexOf(playbackRate)
      const baseIndex = currentIndex === -1 ? PLAYBACK_RATES.indexOf(1) : currentIndex
      const nextIndex = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, baseIndex + direction))
      applyPlaybackRate(PLAYBACK_RATES[nextIndex])
    },
    [applyPlaybackRate, playbackRate]
  )

  const updateBufferAhead = useCallback((element: HTMLVideoElement): void => {
    let ahead = 0
    const position = element.currentTime
    for (let index = 0; index < element.buffered.length; index += 1) {
      if (element.buffered.start(index) <= position + 0.25 && element.buffered.end(index) > position) {
        ahead = Math.max(ahead, element.buffered.end(index) - position)
      }
    }
    setBufferAhead(Math.max(0, ahead))
  }, [])

  useEffect(() => {
    if (!buffering || video.cached) {
      setSlowBuffer(false)
      return
    }
    const timer = window.setTimeout(() => setSlowBuffer(true), 3500)
    return () => window.clearTimeout(timer)
  }, [buffering, video.cached])

  const saveProgress = useCallback(
    (force = false): void => {
      const element = videoRef.current
      if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return
      const now = Date.now()
      if (!force && now - lastSaveRef.current < 5000) return
      lastSaveRef.current = now
      void api.playback.saveProgress(video.id, element.currentTime, element.duration)
    },
    [video.id]
  )

  useEffect(() => {
    return () => {
      saveProgress(true)
    }
  }, [saveProgress])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (moveOpen || deleteOpen) return
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (event.code === 'Space' && target?.closest('button')) return
      const element = videoRef.current
      switch (event.code) {
        case 'Space':
          event.preventDefault()
          if (phase !== 'ready' || !element) return
          if (element.paused) void element.play()
          else element.pause()
          break
        case 'ArrowLeft':
          if (element) {
            event.preventDefault()
            element.currentTime = Math.max(0, element.currentTime - 10)
          }
          break
        case 'ArrowRight':
          if (element) {
            event.preventDefault()
            element.currentTime = Math.min(element.duration || 0, element.currentTime + 10)
          }
          break
        case 'KeyF':
          void toggleFullscreen()
          break
        case 'KeyM':
          setMuted((value) => !value)
          break
        case 'Minus':
          event.preventDefault()
          shiftPlaybackRate(-1)
          break
        case 'Equal':
          event.preventDefault()
          shiftPlaybackRate(1)
          break
        case 'Escape':
          if (speedOpen) {
            setSpeedOpen(false)
            break
          }
          if (menuOpen) {
            setMenuOpen(false)
            break
          }
          if (!document.fullscreenElement) onClose()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, onClose, moveOpen, deleteOpen, menuOpen, speedOpen, shiftPlaybackRate])

  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!menuOpen && !speedOpen) return
    const close = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
      if (speedRef.current && !speedRef.current.contains(event.target as Node)) setSpeedOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen, speedOpen])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const wakeControls = (): void => {
    setControlsVisible(true)
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    if (playing && phase === 'ready' && !menuOpen && !speedOpen && !moveOpen && !deleteOpen) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2700)
    }
  }

  useEffect(() => {
    if (!playing || phase !== 'ready' || menuOpen || speedOpen || moveOpen || deleteOpen) {
      setControlsVisible(true)
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
      return
    }
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2700)
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [playing, phase, menuOpen, speedOpen, moveOpen, deleteOpen])

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await screenRef.current?.requestFullscreen()
      }
    } catch {
      onToast('No se pudo cambiar a pantalla completa.', 'error')
    }
  }

  const togglePlay = (): void => {
    const element = videoRef.current
    if (!element) return
    if (element.paused) void element.play()
    else element.pause()
    wakeControls()
  }

  const seek = (value: number): void => {
    const element = videoRef.current
    if (!element) return
    element.currentTime = value
    setCurrentTime(value)
    wakeControls()
  }

  const onLoadedMetadata = (): void => {
    const element = videoRef.current
    if (!element) return
    setDuration(element.duration || video.duration || 0)
    element.volume = volume
    element.muted = muted
    element.playbackRate = playbackRate
    updateBufferAhead(element)
    if (!resumeAppliedRef.current && video.watchPosition && video.watchPosition > 5) {
      const max = (element.duration || video.watchDuration || 0) - 8
      if (video.watchPosition < max) {
        element.currentTime = video.watchPosition
        setResumeNotice(video.watchPosition)
        setCurrentTime(video.watchPosition)
        if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = window.setTimeout(() => setResumeNotice(null), 4200)
      }
    }
    resumeAppliedRef.current = true
    void element.play().catch(() => setPlaying(false))
  }

  const retry = async (): Promise<void> => {
    setError('')
    setPhase('loading')
    try {
      const result = await api.playback.open(video.id)
      if (result.state) setDownloadState(result.state)
      if (result.url) {
        setSrc(result.url)
        setPhase('ready')
      } else {
        setPhase('downloading')
      }
    } catch (caught) {
      setError(cleanError(caught))
      setPhase('error')
    }
  }

  const cancel = (): void => {
    void api.playback.cancel(video.id)
    setPhase('cancelled')
  }

  const openExternal = async (): Promise<void> => {
    const needsDownload = !video.cached
    if (needsDownload) onClose()
    setExternalBusy(true)
    try {
      onToast('Preparando el vídeo para el reproductor del sistema…', 'info')
      await api.playback.openExternal(video.id)
      await onChanged()
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    } finally {
      setExternalBusy(false)
    }
  }

  const moveVideo = async (folderId: string | null): Promise<void> => {
    try {
      await api.library.moveVideo(video.id, folderId)
      await onChanged()
      onToast('Vídeo movido de carpeta.', 'success')
    } catch (caught) {
      onToast(cleanError(caught), 'error')
      throw caught
    }
  }

  const deleteVideo = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.library.deleteVideo(video.id)
      onToast('Vídeo eliminado de Telegram.', 'success')
      onDeleted()
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    } finally {
      setBusy(false)
    }
  }

  const percent = progressPercent(
    downloadState?.downloadedBytes ?? 0,
    downloadState?.totalBytes ?? video.size
  )
  const seekPercent = progressPercent(currentTime, duration)
  const isUiHidden = playing && phase === 'ready' && !controlsVisible

  return (
    <div
      className="player-screen"
      ref={screenRef}
      onPointerMove={wakeControls}
      onPointerDown={wakeControls}
    >
      <div
        className="player-backdrop"
        style={video.thumbUrl ? { backgroundImage: `url("${video.thumbUrl}")` } : undefined}
      />
      <div className="player-backdrop-shade" />

      <header className={`player-top${isUiHidden ? ' ui-hidden' : ''}`}>
        <button className="player-back" onClick={onClose} aria-label="Volver a la biblioteca">
          <Icon name="arrow_back" size={22} />
        </button>
        <div className="player-heading">
          <span className="eyebrow">
            {video.cached ? (
              <><Icon name="offline_pin" size={15} /> Copia local</>
            ) : (
              <><Icon name="cloud" size={15} /> Transmitiendo desde Telegram</>
            )}
            {video.parts > 1 ? (
              <>
                <span className="eyebrow-dot" />
                {video.parts} partes unidas
              </>
            ) : null}
          </span>
          <h1>{video.title}</h1>
        </div>
        <div className="player-top-actions">
          {stream?.status === 'streaming' && !video.cached ? (
            <span className="player-chip" title="Bytes guardados en la caché local">
              <Icon name="cloud_download" size={15} />
              {formatPercent(progressPercent(stream.cachedBytes, stream.totalBytes))}% en caché
            </span>
          ) : downloadState?.status === 'downloading' ? (
            <span className="player-chip">
              <span className="mini-spinner" /> {Math.round(percent)}%
            </span>
          ) : null}
          {stream?.status === 'streaming' && !video.cached && bufferAhead > 0 ? (
            <span
              className="player-chip player-chip-quiet"
              title="Segundos de vídeo disponibles en el búfer del reproductor"
            >
              <Icon name="av_timer" size={15} />
              {Math.round(bufferAhead)} s
            </span>
          ) : null}
          <div className="player-menu-wrap" ref={menuRef}>
            <button
              className="player-icon-btn"
              onClick={() => setMenuOpen((value) => !value)}
              aria-label="Opciones del vídeo"
            >
              <Icon name="more_vert" size={22} />
            </button>
            {menuOpen ? (
              <div className="player-menu">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    setMoveOpen(true)
                  }}
                >
                  <Icon name="drive_file_move" size={19} /> Mover a carpeta
                </button>
                {video.cached ? (
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      void api.playback.reveal(video.id)
                    }}
                  >
                    <Icon name="folder_open" size={19} /> Mostrar en el explorador
                  </button>
                ) : null}
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    void openExternal()
                  }}
                >
                  <Icon name="open_in_new" size={19} /> Abrir con otro reproductor
                </button>
                <div className="menu-divider" />
                <button
                  className="danger-text"
                  onClick={() => {
                    setMenuOpen(false)
                    setDeleteOpen(true)
                  }}
                >
                  <Icon name="delete" size={19} /> Eliminar de Telegram
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div
        className="player-stage"
        ref={stageRef}
        onClick={() => {
          if (phase === 'ready') togglePlay()
        }}
        onDoubleClick={() => void toggleFullscreen()}
      >
        {phase === 'ready' && src ? (
          <video
            ref={videoRef}
            className="player-video"
            src={src}
            poster={video.thumbUrl}
            autoPlay
            playsInline
            onLoadedMetadata={onLoadedMetadata}
            onProgress={(event) => updateBufferAhead(event.currentTarget)}
            onWaiting={(event) => {
              setBuffering(true)
              updateBufferAhead(event.currentTarget)
            }}
            onStalled={() => setBuffering(true)}
            onCanPlay={(event) => {
              setBuffering(false)
              updateBufferAhead(event.currentTarget)
            }}
            onPlaying={(event) => {
              setBuffering(false)
              updateBufferAhead(event.currentTarget)
              setPlaying(true)
              wakeControls()
            }}
            onPlay={() => {
              setPlaying(true)
              wakeControls()
            }}
            onPause={() => {
              setPlaying(false)
              setControlsVisible(true)
              saveProgress(true)
            }}
            onEnded={() => {
              setPlaying(false)
              setBuffering(false)
              setControlsVisible(true)
              saveProgress(true)
            }}
            onTimeUpdate={(event) => {
              setCurrentTime(event.currentTarget.currentTime)
              updateBufferAhead(event.currentTarget)
              saveProgress()
            }}
            onSeeked={(event) => updateBufferAhead(event.currentTarget)}
            onVolumeChange={(event) => {
              setVolume(event.currentTarget.volume)
              setMuted(event.currentTarget.muted)
              window.localStorage.setItem('teleplayer-volume', String(event.currentTarget.volume))
            }}
            onError={() => {
              setError('Este formato no se pudo reproducir en la app. Puedes descargarlo y abrirlo con tu reproductor.')
              setPhase('error')
            }}
          />
        ) : null}

        {phase === 'ready' && buffering ? (
          <div className="player-buffering">
            <div className="big-spinner" />
            <span>
              {video.cached
                ? 'Abriendo la copia local…'
                : slowBuffer
                  ? 'Conexión lenta · bufferizando…'
                  : 'Cargando desde Telegram…'}
            </span>
            {!video.cached && slowBuffer ? (
              <small>
                El vídeo seguirá cuando llegue el siguiente bloque. Bajar la velocidad puede
                ayudar a que el búfer aguante.
              </small>
            ) : !video.cached && bufferAhead > 0 ? (
              <small>Búfer: {Math.round(bufferAhead)} s</small>
            ) : null}
          </div>
        ) : null}

        {phase === 'loading' ? (
          <div className="player-state-card">
            <div className="big-spinner" />
            <h2>Preparando el vídeo</h2>
            <p>{video.cached ? 'Abriendo tu copia local…' : 'Conectando con Telegram…'}</p>
          </div>
        ) : null}

        {phase === 'downloading' ? (
          <div className="player-state-card download-card">
            <div
              className="download-ring"
              style={{ '--ring-progress': `${percent * 3.6}deg` } as CSSProperties}
            >
              <Icon name="cloud_download" size={34} />
            </div>
            <span className="eyebrow">Copia local para reproducir</span>
            <h2>Guardando el vídeo desde Telegram</h2>
            <p>
              {formatBytes(downloadState?.downloadedBytes ?? 0)} de {formatBytes(video.size)}
              {downloadState?.speed ? ` · ${formatSpeed(downloadState.speed)}` : ''}
            </p>
            <div className="download-progressbar">
              <span style={{ width: `${percent}%` }} />
            </div>
            <strong className="download-percent">{formatPercent(percent)}%</strong>
            {video.parts > 1 ? (
              <p className="download-note">
                <Icon name="call_split" size={16} /> Este archivo se guardó en {video.parts} partes y
                se está uniendo para reproducirlo.
              </p>
            ) : null}
            <div className="player-state-actions">
              <button className="btn text light" onClick={cancel}>
                Cancelar descarga
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'cancelled' ? (
          <div className="player-state-card">
            <div className="big-status-icon warning">
              <Icon name="cloud_off" size={36} />
            </div>
            <h2>Descarga cancelada</h2>
            <p>El vídeo sigue a salvo en Telegram. Puedes volver a descargarlo cuando quieras.</p>
            <div className="player-state-actions">
              <button className="btn filled" onClick={() => void retry()}>
                <Icon name="refresh" size={19} /> Reintentar
              </button>
              <button className="btn text light" onClick={onClose}>
                Volver
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="player-state-card">
            <div className="big-status-icon error">
              <Icon name="error" size={36} />
            </div>
            <h2>No se pudo reproducir</h2>
            <p>{error}</p>
            <div className="player-state-actions">
              <button className="btn filled" onClick={() => void retry()}>
                <Icon name="refresh" size={19} /> Reintentar
              </button>
              <button
                className="btn text light"
                onClick={() => void openExternal()}
                disabled={externalBusy}
              >
                <Icon name="open_in_new" size={19} />
                {externalBusy ? 'Preparando…' : 'Abrir con otro reproductor'}
              </button>
              <button className="btn text light" onClick={onClose}>
                Volver
              </button>
            </div>
          </div>
        ) : null}

        {resumeNotice !== null ? (
          <div className="resume-toast">
            <Icon name="history" size={18} /> Reanudando desde {formatTimecode(resumeNotice)}
          </div>
        ) : null}
      </div>

      {phase === 'ready' ? (
        <div className={`player-controls-wrap${isUiHidden ? ' ui-hidden' : ''}`} onClick={(event) => event.stopPropagation()}>
          <div className="player-controls">
            <div className="seek-row">
              <span className="time-label">{formatTimecode(currentTime)}</span>
              <input
                className="player-slider"
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(currentTime, duration || 0)}
                onChange={(event) => seek(Number(event.target.value))}
                style={{ '--seek': `${seekPercent}%` } as CSSProperties}
                aria-label="Posición del vídeo"
              />
              <span className="time-label">{formatDuration(duration)}</span>
            </div>

            <div className="control-row">
              <div className="control-group left">
                <button className="player-icon-btn" onClick={togglePlay} aria-label={playing ? 'Pausar' : 'Reproducir'}>
                  <Icon name={playing ? 'pause' : 'play_arrow'} filled size={28} />
                </button>
                <button
                  className="player-icon-btn"
                  onClick={() => {
                    const element = videoRef.current
                    if (element) element.currentTime = Math.max(0, element.currentTime - 10)
                  }}
                  aria-label="Retroceder 10 segundos"
                >
                  <Icon name="replay_10" size={23} />
                </button>
                <button
                  className="player-icon-btn"
                  onClick={() => {
                    const element = videoRef.current
                    if (element) element.currentTime = Math.min(element.duration || 0, element.currentTime + 10)
                  }}
                  aria-label="Avanzar 10 segundos"
                >
                  <Icon name="forward_10" size={23} />
                </button>
                <div className="volume-control">
                  <button
                    className="player-icon-btn"
                    onClick={() => setMuted((value) => !value)}
                    aria-label={muted ? 'Activar sonido' : 'Silenciar'}
                  >
                    <Icon
                      name={muted || volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'}
                      size={22}
                    />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={muted ? 0 : volume}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      setVolume(next)
                      setMuted(next === 0)
                    }}
                    className="volume-slider"
                    style={{ '--vol': `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
                    aria-label="Volumen"
                  />
                </div>
              </div>

              <div className="control-group center">
                <span className="playing-title">{video.title}</span>
              </div>

              <div className="control-group right">
                <div className="player-speed-wrap" ref={speedRef}>
                  <button
                    className={`player-speed-btn${speedOpen ? ' active' : ''}`}
                    onClick={() => {
                      setSpeedOpen((value) => !value)
                      setControlsVisible(true)
                    }}
                    aria-label="Velocidad de reproducción"
                    aria-haspopup="menu"
                    aria-expanded={speedOpen}
                    title="Velocidad de reproducción (teclas - y +)"
                  >
                    {formatPlaybackRate(playbackRate)}
                  </button>
                  {speedOpen ? (
                    <div className="player-speed-menu" role="menu" aria-label="Velocidad de reproducción">
                      {PLAYBACK_RATES.map((rate) => (
                        <button
                          key={rate}
                          role="menuitemradio"
                          aria-checked={rate === playbackRate}
                          className={rate === playbackRate ? 'selected' : ''}
                          onClick={() => {
                            applyPlaybackRate(rate)
                            setSpeedOpen(false)
                          }}
                        >
                          {rate === 1 ? 'Normal' : formatPlaybackRate(rate)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <button
                  className="player-icon-btn"
                  onClick={() => {
                    const element = videoRef.current
                    if (element && document.pictureInPictureEnabled) {
                      void element.requestPictureInPicture().catch(() => undefined)
                    }
                  }}
                  aria-label="Imagen en imagen"
                  title="Imagen en imagen"
                >
                  <Icon name="picture_in_picture_alt" size={22} />
                </button>
                <button
                  className="player-icon-btn"
                  onClick={() => void toggleFullscreen()}
                  aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
                >
                  <Icon name={fullscreen ? 'fullscreen_exit' : 'fullscreen'} size={23} />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <MoveDialog
        open={moveOpen}
        video={video}
        folders={folders}
        currentFolderId={video.folderId}
        onClose={() => setMoveOpen(false)}
        onMove={moveVideo}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Eliminar vídeo de Telegram"
        message={`Se borrarán todas las partes de «${video.title}» del canal y la copia local. Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar definitivamente"
        danger
        busy={busy}
        onConfirm={() => void deleteVideo()}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  )
}
