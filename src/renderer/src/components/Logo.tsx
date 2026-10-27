interface LogoProps {
  size?: number
  muted?: boolean
}

export function Logo({ size = 36, muted = false }: LogoProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={`tp-logo${muted ? ' muted' : ''}`}
    >
      <defs>
        <linearGradient id="tp-logo-gradient" x1="8" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--md-primary)" />
          <stop offset="0.55" stopColor="var(--md-tertiary)" />
          <stop offset="1" stopColor="var(--md-secondary)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="19" fill="url(#tp-logo-gradient)" />
      <rect x="1" y="1" width="62" height="62" rx="19" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
      <path
        d="M26.2 20.9c0-2.1 2.3-3.4 4.1-2.3l16.1 9.6c1.8 1.1 1.8 3.6 0 4.7L30.3 42.5c-1.8 1.1-4.1-.2-4.1-2.3V20.9Z"
        fill="rgba(255,255,255,0.95)"
      />
      <circle cx="47.5" cy="17.5" r="4.5" fill="rgba(255,255,255,0.35)" />
    </svg>
  )
}
