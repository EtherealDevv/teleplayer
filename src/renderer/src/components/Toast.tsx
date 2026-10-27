import { Icon } from './Icon'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastData {
  id: number
  message: string
  tone: ToastTone
}

interface ToastProps {
  toast: ToastData | null
  onDismiss: () => void
}

export function Toast({ toast, onDismiss }: ToastProps): JSX.Element | null {
  if (!toast) return null
  const icon =
    toast.tone === 'success' ? 'check_circle' : toast.tone === 'error' ? 'error' : 'info'
  return (
    <div className={`toast ${toast.tone}`} role="status">
      <Icon name={icon} filled size={21} />
      <span>{toast.message}</span>
      <button className="toast-close" onClick={onDismiss} aria-label="Cerrar aviso">
        <Icon name="close" size={18} />
      </button>
    </div>
  )
}
