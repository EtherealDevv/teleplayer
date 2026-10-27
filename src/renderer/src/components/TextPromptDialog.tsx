import { useEffect, useState } from 'react'
import { Modal } from './Modal'

interface TextPromptDialogProps {
  open: boolean
  title: string
  label: string
  description?: string
  initialValue?: string
  confirmLabel?: string
  icon?: string
  onClose: () => void
  onSubmit: (value: string) => Promise<void>
}

export function TextPromptDialog({
  open,
  title,
  label,
  description,
  initialValue = '',
  confirmLabel = 'Guardar',
  icon = 'edit',
  onClose,
  onSubmit
}: TextPromptDialogProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setBusy(false)
    setError('')
  }, [open, initialValue])

  const submit = async (): Promise<void> => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(value.trim())
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      icon={icon}
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn filled" onClick={submit} disabled={!value.trim() || busy}>
            {busy ? 'Guardando…' : confirmLabel}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{label}</span>
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  )
}
