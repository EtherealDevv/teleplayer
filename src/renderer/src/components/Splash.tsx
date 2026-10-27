import { Logo } from './Logo'

interface SplashProps {
  message?: string
}

export function Splash({ message = 'Preparando tu videoteca…' }: SplashProps): JSX.Element {
  return (
    <div className="splash">
      <div className="splash-glow one" />
      <div className="splash-glow two" />
      <div className="splash-content">
        <Logo size={74} />
        <h1>TelePlayer</h1>
        <p>{message}</p>
        <div className="splash-loader">
          <span />
        </div>
      </div>
    </div>
  )
}
