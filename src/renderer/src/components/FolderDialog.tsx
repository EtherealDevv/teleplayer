import { useEffect, useState } from 'react'
import type { Folder, FolderInput } from '../../../shared/types'
import { Modal } from './Modal'
import { Icon } from './Icon'

const EMOJIS = ['🎬', '🎞️', '🍿', '📺', '🌙', '⭐', '🔥', '❤️', '🌊', '🎮', '📚', '🎵', '🧠', '🚀', '🏔️', '🧡']
const COLORS = ['#3390EC', '#0078D7', '#8774E1', '#E17076', '#7BC862', '#E5A54B', '#65AADD', '#A695E7']

interface FolderDialogProps {
  open: boolean
  mode: 'create' | 'edit'
  folder?: Folder | null
  onClose: () => void
  onSave: (input: FolderInput) => Promise<void>
}

export function FolderDialog({
  open,
  mode,
  folder,
  onClose,
  onSave
}: FolderDialogProps): JSX.Element {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🎬')
  const [color, setColor] = useState(COLORS[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(folder?.name ?? '')
    setEmoji(folder?.emoji ?? '🎬')
    setColor(folder?.color ?? COLORS[0])
    setError('')
    setBusy(false)
  }, [open, folder])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await onSave({ name: name.trim(), emoji, color })
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={mode === 'create' ? 'Nueva carpeta' : 'Editar carpeta'}
      icon={mode === 'create' ? 'create_new_folder' : 'folder_open'}
      description={
        mode === 'create'
          ? 'Organiza tu videoteca. Las carpetas se guardan en tu canal de Telegram.'
          : 'Cambia el nombre, el icono o el color de la carpeta.'
      }
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose} type="button">
            Cancelar
          </button>
          <button className="btn filled" onClick={submit} disabled={!name.trim() || busy} type="button">
            {busy ? 'Guardando…' : mode === 'create' ? 'Crear carpeta' : 'Guardar'}
          </button>
        </>
      }
    >
      <form className="folder-form" onSubmit={submit}>
        <label className="field">
          <span>Nombre</span>
          <input
            autoFocus
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
            placeholder="Películas, Series, Viajes…"
          />
        </label>
        <div className="field">
          <span>Icono</span>
          <div className="emoji-grid">
            {EMOJIS.map((item) => (
              <button
                key={item}
                type="button"
                className={`emoji-choice${emoji === item ? ' selected' : ''}`}
                onClick={() => setEmoji(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Color</span>
          <div className="color-row">
            {COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={`color-choice${color === item ? ' selected' : ''}`}
                style={{ background: item }}
                onClick={() => setColor(item)}
                aria-label={`Color ${item}`}
              >
                {color === item ? <Icon name="check" size={15} /> : null}
              </button>
            ))}
          </div>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </Modal>
  )
}
