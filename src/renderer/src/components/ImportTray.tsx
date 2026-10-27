import { useMemo, useState } from 'react'
import type { ImportProgress } from '../../../shared/types'
import { formatBytes, formatPercent, formatSpeed, progressPercent } from '../utils'
import { Icon } from './Icon'

interface ImportTrayProps {
  jobs: Record<string, ImportProgress>
  onDismiss: (jobId: string) => void
}

export function ImportTray({ jobs, onDismiss }: ImportTrayProps): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const ordered = useMemo(() => {
    const list = Object.values(jobs)
    const weight = (status: ImportProgress['status']): number => {
      if (status === 'uploading' || status === 'preparing' || status === 'queued') return 0
      return 1
    }
    return list.sort((a, b) => weight(a.status) - weight(b.status))
  }, [jobs])

  if (ordered.length === 0) return null

  const active = ordered.filter(
    (job) => job.status === 'uploading' || job.status === 'preparing' || job.status === 'queued'
  )
  const done = ordered.filter((job) => job.status === 'done')
  const failed = ordered.filter((job) => job.status === 'error')

  if (collapsed) {
    return (
      <button className="import-pill" onClick={() => setCollapsed(false)}>
        <span className="mini-spinner" />
        {active.length > 0
          ? `Subiendo ${active.length} ${active.length === 1 ? 'vídeo' : 'vídeos'}`
          : 'Ver subidas'}
        <Icon name="expand_less" size={18} />
      </button>
    )
  }

  return (
    <div className="import-tray">
      <header className="import-tray-head">
        <span className="import-tray-icon">
          <Icon name="cloud_upload" filled size={21} />
        </span>
        <div>
          <strong>
            {active.length > 0
              ? `Subiendo a Telegram${active.length > 1 ? ` · ${active.length}` : ''}`
              : failed.length > 0
                ? 'Alguna subida necesita atención'
                : 'Vídeos guardados'}
          </strong>
          <span>
            {active.length > 0
              ? 'Puedes seguir usando TelePlayer'
              : `${done.length} ${done.length === 1 ? 'archivo listo' : 'archivos listos'}`}
          </span>
        </div>
        <button className="icon-btn small" onClick={() => setCollapsed(true)} aria-label="Contraer panel">
          <Icon name="expand_more" size={19} />
        </button>
      </header>

      <div className="import-list">
        {ordered.map((job) => {
          const percent = progressPercent(job.uploadedBytes, job.totalBytes)
          const isActive = job.status === 'uploading' || job.status === 'preparing'
          const isDone = job.status === 'done'
          const isError = job.status === 'error' || job.status === 'cancelled'
          return (
            <div className={`import-item ${job.status}`} key={job.jobId}>
              <div className="import-item-top">
                <span className="import-file-icon">
                  <Icon
                    name={isDone ? 'check_circle' : isError ? 'error' : job.status === 'preparing' ? 'content_cut' : 'movie'}
                    filled={isDone || isError}
                    size={19}
                  />
                </span>
                <div className="import-file-copy">
                  <strong title={job.name}>{job.title}</strong>
                  <span>
                    {formatBytes(job.size)}
                    {job.partCount > 1 ? ` · ${job.partCount} partes` : ''}
                    {isActive && job.speed > 0 ? ` · ${formatSpeed(job.speed)}` : ''}
                  </span>
                </div>
                {isActive ? (
                  <span className="import-percent">{formatPercent(percent)}%</span>
                ) : (
                  <button
                    className="icon-btn small"
                    onClick={() => onDismiss(job.jobId)}
                    aria-label="Quitar de la lista"
                  >
                    <Icon name="close" size={17} />
                  </button>
                )}
              </div>

              {isActive ? (
                <>
                  <div className="import-bar">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  <span className="import-detail">{job.detail || 'Preparando…'}</span>
                </>
              ) : isError ? (
                <span className="import-error">{job.error || 'No se pudo subir el vídeo.'}</span>
              ) : (
                <span className="import-detail">
                  <Icon name="cloud_done" size={14} /> Guardado en tu canal privado
                </span>
              )}
            </div>
          )
        })}
      </div>

      <footer className="import-tray-footer">
        <Icon name="call_split" size={15} />
        Los archivos que superan el límite de Telegram se dividen y se reconstruyen automáticamente.
      </footer>
    </div>
  )
}
