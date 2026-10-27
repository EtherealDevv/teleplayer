import type { CSSProperties, HTMLAttributes } from 'react'

interface IconProps extends HTMLAttributes<HTMLSpanElement> {
  name: string
  filled?: boolean
  size?: number
}

export function Icon({ name, filled, size = 22, className, style, ...rest }: IconProps): JSX.Element {
  return (
    <span
      className={`material-symbols-rounded tp-icon${filled ? ' filled' : ''}${className ? ` ${className}` : ''}`}
      style={{ fontSize: size, ...(style as CSSProperties) }}
      aria-hidden="true"
      {...rest}
    >
      {name}
    </span>
  )
}
