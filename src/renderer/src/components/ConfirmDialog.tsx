import { Modal } from './Modal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  icon?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Eliminar',
  cancelLabel = 'Cancelar',
  danger = false,
  icon,
  busy = false,
  onConfirm,
  onClose
}: ConfirmDialogProps): JSX.Element {
  return (
    <Modal
      open={open}
      title={title}
      description={message}
      icon={icon ?? (danger ? 'delete' : 'help')}
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'danger' : 'filled'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Un momento…' : confirmLabel}
          </button>
        </>
      }
    />
  )
}
