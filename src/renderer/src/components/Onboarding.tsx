import { useEffect, useMemo, useRef, useState } from 'react'
import type { AuthState, DetectedCountry } from '../../../shared/types'
import { api } from '../api'
import { cleanError } from '../utils'
import { Logo } from './Logo'
import { Icon } from './Icon'

type Step = 'credentials' | 'phone' | 'code' | 'password'

interface OnboardingProps {
  auth: AuthState
  detectedCountry?: DetectedCountry
  onAuth: (state: AuthState) => void
}

export function Onboarding({ auth, detectedCountry, onAuth }: OnboardingProps): JSX.Element {
  const [step, setStep] = useState<Step>(auth.apiConfigured ? 'phone' : 'credentials')
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState(
    auth.phone ?? (detectedCountry ? `${detectedCountry.dialCode} ` : '+')
  )
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const codeRef = useRef<HTMLInputElement | null>(null)
  const passwordRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (auth.status === 'code-sent') {
      setStep('code')
    } else if (auth.status === 'password-needed') {
      setStep('password')
    } else if (auth.status === 'signed-out' || auth.status === 'no-credentials') {
      setStep(auth.apiConfigured ? 'phone' : 'credentials')
      setError('')
      setCode('')
      setPassword('')
    }
  }, [auth.status, auth.apiConfigured])

  useEffect(() => {
    if (seconds <= 0) return
    const timer = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [seconds])

  useEffect(() => {
    if (step === 'code') setTimeout(() => codeRef.current?.focus(), 150)
    if (step === 'password') setTimeout(() => passwordRef.current?.focus(), 150)
  }, [step])

  const passwordNeeded = auth.status === 'password-needed'
  const fatal = auth.status === 'error'

  const submitCredentials = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.configure(apiId, apiHash)
      onAuth(state)
      setStep('phone')
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submitPhone = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.sendCode(phone)
      onAuth(state)
      setStep('code')
      setCode('')
      setSeconds(30)
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !code.trim()) return
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.signIn(code)
      onAuth(state)
      if (state.status === 'password-needed') setStep('password')
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.password(password)
      onAuth(state)
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const resend = async (): Promise<void> => {
    if (seconds > 0 || busy) return
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.sendCode(phone)
      onAuth(state)
      setSeconds(30)
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.reconnect()
      onAuth(state)
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const state = await api.auth.resetCredentials()
      onAuth(state)
      setStep('credentials')
    } catch (caught) {
      setError(cleanError(caught))
    } finally {
      setBusy(false)
    }
  }

  const title = useMemo(() => {
    if (fatal) return 'No pudimos conectar'
    switch (step) {
      case 'credentials':
        return 'Conecta tu Telegram'
      case 'phone':
        return 'Tu número de Telegram'
      case 'code':
        return 'Escribe el código'
      case 'password':
        return 'Verificación en dos pasos'
    }
  }, [step, fatal])

  const subtitle = useMemo(() => {
    if (fatal) return 'La sesión guardada no se pudo usar. Puedes reintentar o entrar con otra cuenta.'
    switch (step) {
      case 'credentials':
        return 'TelePlayer usa tu propia aplicación de Telegram. Es gratis y solo se tarda un minuto.'
      case 'phone':
        return 'Te enviaremos un código a tu app de Telegram. Después podrás guardar tu videoteca en la nube.'
      case 'code':
        return auth.codeViaEmail
          ? `Enviamos el código al correo asociado a tu cuenta${auth.phone ? ` (${auth.phone})` : ''}.`
          : auth.codeViaApp
            ? `Enviamos el código a tu Telegram${auth.phone ? ` (${auth.phone})` : ''}.`
            : `Enviamos el código por SMS${auth.phone ? ` a ${auth.phone}` : ''}.`
      case 'password':
        return 'Tu cuenta tiene una contraseña adicional. Escríbela para terminar de entrar.'
    }
  }, [step, fatal, auth.codeViaApp, auth.codeViaEmail, auth.phone])

  const stepIndex = step === 'credentials' ? 0 : step === 'phone' ? 1 : 2

  return (
    <div className="onboarding">
      <div className="onboarding-pattern" aria-hidden="true" />
      <div className="onboarding-glow one" />
      <div className="onboarding-glow two" />

      <div className="onboarding-shell">
        <section className="auth-card">
          <div className="auth-brand">
            <Logo size={64} />
            <strong>TelePlayer</strong>
            <span>Tu videoteca privada en Telegram</span>
          </div>

          <div className="auth-progress" aria-hidden="true">
            <span className={stepIndex >= 0 ? 'done' : ''} />
            <span className={stepIndex >= 1 ? 'done' : ''} />
            <span className={stepIndex >= 2 ? 'done' : ''} />
          </div>

          <header className="auth-heading">
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </header>

          {fatal ? (
            <div className="auth-error-state">
              <div className="big-status-icon error">
                <Icon name="cloud_off" size={32} />
              </div>
              <p>{auth.error || 'No hay conexión con Telegram.'}</p>
              <div className="auth-actions">
                <button className="btn filled" onClick={retry} disabled={busy}>
                  {busy ? 'Conectando…' : 'Reintentar'}
                </button>
                <button className="btn text" onClick={reset} disabled={busy}>
                  Usar otra cuenta
                </button>
              </div>
            </div>
          ) : null}

          {!fatal && step === 'credentials' ? (
            <form className="auth-form" onSubmit={submitCredentials}>
              <div className="guide-toggle-row">
                <p className="muted">
                  ¿No tienes credenciales? Son las de tu propia app en Telegram.
                </p>
                <button
                  className="btn text compact"
                  type="button"
                  onClick={() => setShowGuide((value) => !value)}
                >
                  {showGuide ? 'Ocultar guía' : 'Ver guía'}
                  <Icon name={showGuide ? 'expand_less' : 'expand_more'} size={18} />
                </button>
              </div>

              {showGuide ? (
                <ol className="guide-list">
                  <li>
                    <b>1.</b> Abre <b>my.telegram.org</b> e inicia sesión con tu número.
                  </li>
                  <li>
                    <b>2.</b> Entra en <b>API development tools</b>.
                  </li>
                  <li>
                    <b>3.</b> Crea una app con cualquier nombre (por ejemplo, TelePlayer).
                  </li>
                  <li>
                    <b>4.</b> Copia el <b>api_id</b> y el <b>api_hash</b> aquí.
                  </li>
                </ol>
              ) : null}

              <button
                type="button"
                className="btn tonal full"
                onClick={() => api.openExternal('https://my.telegram.org/apps')}
              >
                <Icon name="open_in_new" size={18} />
                Abrir my.telegram.org
              </button>

              <label className="field">
                <span>api_id</span>
                <input
                  inputMode="numeric"
                  value={apiId}
                  onChange={(event) => setApiId(event.target.value.replace(/[^\d]/g, ''))}
                  placeholder="12345678"
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>api_hash</span>
                <input
                  value={apiHash}
                  onChange={(event) => setApiHash(event.target.value.trim())}
                  placeholder="0123456789abcdef0123456789abcdef"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>

              {error ? <p className="form-error">{error}</p> : null}

              <button
                className="btn filled full lg"
                type="submit"
                disabled={busy || !apiId || apiHash.length < 32}
              >
                {busy ? 'Guardando…' : 'Continuar'}
                <Icon name="arrow_forward" size={19} />
              </button>
              <p className="secure-note">
                <Icon name="lock" size={15} /> Se guardan cifradas con el almacén seguro de
                Windows.
              </p>
            </form>
          ) : null}

          {!fatal && step === 'phone' ? (
            <form className="auth-form" onSubmit={submitPhone}>
              <label className="field phone-field">
                <span>Número de teléfono</span>
                <input
                  autoFocus
                  inputMode="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="+34 600 000 000"
                  autoComplete="tel"
                />
              </label>
              <p
                className={`field-hint${
                  detectedCountry && !auth.phone ? ' detected-country' : ''
                }`}
              >
                {detectedCountry && !auth.phone ? (
                  <>
                    <Icon name="my_location" size={14} />
                    <span>
                      País detectado:{' '}
                      <b>
                        {detectedCountry.name} ({detectedCountry.dialCode})
                      </b>
                      . Cambia el prefijo si no es el correcto. Telegram enviará el código a tus
                      dispositivos, no hace falta que llegue por SMS.
                    </span>
                  </>
                ) : (
                  <>
                    Incluye el prefijo del país. Telegram enviará el código a tus dispositivos, no
                    hace falta que llegue por SMS.
                  </>
                )}
              </p>
              {error ? <p className="form-error">{error}</p> : null}
              <button className="btn filled full lg" type="submit" disabled={busy || phone.length < 8}>
                {busy ? 'Enviando código…' : 'Enviar código'}
                <Icon name="send" size={18} />
              </button>
              <button
                type="button"
                className="btn text full"
                onClick={() => setStep('credentials')}
              >
                Usar otras credenciales API
              </button>
            </form>
          ) : null}

          {!fatal && step === 'code' ? (
            <form className="auth-form" onSubmit={submitCode}>
              <label className="field">
                <span>Código de verificación</span>
                <input
                  ref={codeRef}
                  className="code-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, '').slice(0, 8))}
                  placeholder="00000"
                />
              </label>
              {auth.codeViaEmail ? (
                <p className="field-hint">
                  Revisa el correo asociado a tu cuenta de Telegram. Si no lo encuentras, mira en
                  spam.
                </p>
              ) : null}
              <div className="auth-inline">
                <button type="button" className="btn text compact" onClick={() => setStep('phone')}>
                  <Icon name="arrow_back" size={17} /> Otro número
                </button>
                <button
                  type="button"
                  className="btn text compact"
                  onClick={resend}
                  disabled={seconds > 0 || busy}
                >
                  {seconds > 0 ? `Reenviar en ${seconds}s` : 'Reenviar código'}
                </button>
              </div>
              {error ? <p className="form-error">{error}</p> : null}
              <button className="btn filled full lg" type="submit" disabled={busy || code.length < 3}>
                {busy ? 'Comprobando…' : 'Entrar'}
                <Icon name="login" size={18} />
              </button>
            </form>
          ) : null}

          {!fatal && step === 'password' ? (
            <form className="auth-form" onSubmit={submitPassword}>
              <div className="big-status-icon password">
                <Icon name="password" filled size={32} />
              </div>
              <label className="field">
                <span>Contraseña de verificación en dos pasos</span>
                <div className="input-with-action">
                  <input
                    ref={passwordRef}
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Tu contraseña de Telegram"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  >
                    <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={20} />
                  </button>
                </div>
              </label>
              <p className="field-hint">
                {passwordNeeded
                  ? 'Telegram pide esta contraseña porque la activaste en Ajustes › Privacidad.'
                  : 'La contraseña que protege tu cuenta de Telegram.'}
              </p>
              {error ? <p className="form-error">{error}</p> : null}
              <button className="btn filled full lg" type="submit" disabled={busy || !password}>
                {busy ? 'Entrando…' : 'Desbloquear mi cuenta'}
                <Icon name="lock_open" size={18} />
              </button>
            </form>
          ) : null}

          <footer className="auth-footer">
            <Icon name="verified_user" size={16} /> Sin servidores intermedios: tu PC habla
            directamente con Telegram.
          </footer>
        </section>

        <div className="onboarding-features">
          <span>
            <Icon name="cloud_done" size={16} /> Backup privado
          </span>
          <span>
            <Icon name="call_split" size={16} /> Sin límite de 2 GB
          </span>
          <span>
            <Icon name="shield_lock" size={16} /> Conexión directa
          </span>
        </div>

        <p className="onboarding-legal">
          TelePlayer no está afiliado a Telegram. Tu sesión y tus claves se guardan cifradas en este
          PC, y tus archivos permanecen en tu cuenta.
        </p>
      </div>
    </div>
  )
}
