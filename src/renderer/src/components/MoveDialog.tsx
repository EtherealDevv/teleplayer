import { useEffect, useState } from 'react'
import type { Folder, VideoItem } from '../../../shared/types'
import { Modal } from './Modal'
import { Icon } from './Icon'

interface MoveDialogProps {
  open: boolean
  video?: VideoItem | null
  folders: Folder[]
  currentFolderId?: string | null
  onClose: () => void
  onMove: (folderId: string | null) => Promise<void>
}

export function MoveDialog({
  open,
  video,
  folders,
  currentFolderId,
  onClose,
  onMove
}: MoveDialogProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setSelected(currentFolderId ?? null)
    setBusy(false)
    setError('')
  }, [open, currentFolderId])

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onMove(selected)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="Mover a una carpeta"
      icon="drive_file_move"
      description={video ? video.title : undefined}
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn filled" onClick={submit} disabled={busy}>
            {busy ? 'Moviendo…' : 'Mover aquí'}
          </button>
        </>
      }
    >
      <div className="move-list">
        <button
          type="button"
          className={`move-option${selected === null ? ' selected' : ''}`}
          onClick={() => setSelected(null)}
        >
          <span className="folder-emoji">🗂️</span>
          <span className="move-name">Sin carpeta</span>
          {selected === null ? <Icon name="check_circle" filled size={22} /> : null}
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={`move-option${selected === folder.id ? ' selected' : ''}`}
            onClick={() => setSelected(folder.id)}
          >
            <span className="folder-emoji" style={{ background: `${folder.color}22` }}>
              {folder.emoji}
            </span>
            <span className="move-name">{folder.name}</span>
            {selected === folder.id ? <Icon name="check_circle" filled size={22} /> : null}
          </button>
        ))}
        {folders.length === 0 ? (
          <p className="muted centered">Todavía no hay carpetas. Crea una desde la barra lateral.</p>
        ) : null}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  )
}
