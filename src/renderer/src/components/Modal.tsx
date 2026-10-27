import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

interface ModalProps {
  open: boolean
  title: string
  icon?: string
  description?: string
  onClose: () => void
  children?: ReactNode
  actions?: ReactNode
  wide?: boolean
}

export function Modal({
  open,
  title,
  icon,
  description,
  onClose,
  children,
  actions,
  wide
}: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`modal-card${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-heading">
          {icon ? (
            <span className="modal-icon">
              <Icon name={icon} size={26} />
            </span>
          ) : null}
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={20} />
          </button>
        </div>
        {children ? <div className="modal-body">{children}</div> : null}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>,
    document.body
  )
}
