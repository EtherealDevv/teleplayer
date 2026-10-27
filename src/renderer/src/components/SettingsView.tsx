import { useEffect, useState } from 'react'
import type { AppSettings, AuthState, CacheInfo, Library } from '../../../shared/types'
import { api } from '../api'
import type { ToastTone } from './Toast'
import { seedSwatches } from '../theme'
import { cleanError, formatBytes, initialOf, progressPercent } from '../utils'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'

interface SettingsViewProps {
  settings: AppSettings
  auth: AuthState
  library: Library
  accentColor: string
  appVersion: string
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onRefresh: (silent?: boolean) => Promise<void>
  onToast: (message: string, tone?: ToastTone) => void
  onBack: () => void
}

const LIMITS = [
  { value: 5, label: '5 GB' },
  { value: 10, label: '10 GB' },
  { value: 20, label: '20 GB' },
  { value: 50, label: '50 GB' },
  { value: 0, label: 'Sin límite' }
]

export function SettingsView({
  settings,
  auth,
  library,
  accentColor,
  appVersion,
  onSettingsChange,
  onRefresh,
  onToast,
  onBack
}: SettingsViewProps): JSX.Element {
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const user = auth.user
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Tu cuenta'

  const loadCache = async (): Promise<void> => {
    try {
      setCache(await api.library.cacheInfo())
    } catch {
      setCache(null)
    }
  }

  useEffect(() => {
    void loadCache()
  }, [library.videos])

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      await onSettingsChange(patch)
      if (patch.cacheLimitGb !== undefined) void loadCache()
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    }
  }

  const clearCache = async (): Promise<void> => {
    setBusy(true)
    const before = cache?.bytes ?? 0
    try {
      const info = await api.library.clearCache()
      setCache(info)
      await onRefresh(true)
      const freed = Math.max(0, before - info.bytes)
      if (info.bytes > 0) {
        onToast(
          `Se liberaron ${formatBytes(freed)}. ${formatBytes(
            info.bytes
          )} siguen en uso por el reproductor.`,
          'info'
        )
      } else {
        onToast('Caché local vaciada. Los vídeos siguen en Telegram.', 'success')
      }
      setClearOpen(false)
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.auth.logout()
      onToast('Sesión cerrada. Tu biblioteca sigue en Telegram.', 'success')
      setLogoutOpen(false)
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    } finally {
      setBusy(false)
    }
  }

  const resetCredentials = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.auth.resetCredentials()
      onToast('Credenciales API eliminadas de este PC.', 'success')
      setResetOpen(false)
    } catch (caught) {
      onToast(cleanError(caught), 'error')
    } finally {
      setBusy(false)
    }
  }

  const cachePercent = progressPercent(cache?.bytes ?? 0, cache?.limitBytes ?? 0)
  const themeOptions: Array<{ value: AppSettings['themeMode']; icon: string; label: string }> = [
    { value: 'light', icon: 'light_mode', label: 'Claro' },
    { value: 'dark', icon: 'dark_mode', label: 'Oscuro' },
    { value: 'system', icon: 'brightness_auto', label: 'Sistema' }
  ]

  return (
    <div className="settings-view">
      <header className="settings-topbar">
        <button className="icon-btn settings-back" onClick={onBack} aria-label="Volver a la biblioteca">
          <Icon name="arrow_back" size={22} />
        </button>
        <h1>Ajustes</h1>
        <span className="settings-topbar-spacer" />
      </header>

      <div className="settings-scroll">
        <div className="settings-layout">
          <section className="settings-profile">
            <span className="avatar big">{initialOf(name)}</span>
            <div className="settings-profile-copy">
              <strong>{name}</strong>
              <span>
                {user?.username ? `@${user.username}` : 'Sin nombre de usuario'}
                {user?.premium ? ' · Premium' : ''}
              </span>
              <span>{user?.phone || auth.phone || 'Número oculto'}</span>
            </div>
            <span className="account-status">
              <span className="status-dot" /> Conectada
            </span>
          </section>

          <section className="settings-card appearance-card">
            <div className="settings-card-head">
              <span className="settings-icon">
                <Icon name="palette" size={21} />
              </span>
              <div>
                <h2>Apariencia</h2>
                <p>Estilo Telegram, con el color que elijas.</p>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-copy">
                <strong>Tema</strong>
                <span>Sigue al sistema o fija un modo.</span>
              </div>
              <div className="segmented">
                {themeOptions.map((option) => (
                  <button
                    key={option.value}
                    className={settings.themeMode === option.value ? 'selected' : ''}
                    onClick={() => void update({ themeMode: option.value })}
                  >
                    <Icon name={option.icon} size={17} />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row column-on-narrow">
              <div className="setting-copy">
                <strong>Color de acento</strong>
                <span>Se usa en chats, botones y enlaces.</span>
              </div>
              <div className="appearance-preview" aria-hidden="true">
                <span className="preview-dot primary" />
                <span className="preview-dot secondary" />
                <span className="preview-dot tertiary" />
                <span className="preview-pill">TelePlayer</span>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-copy">
                <strong>Usar el color de Windows</strong>
                <span>Cambia el acento cuando cambies el del sistema.</span>
              </div>
              <button
                className={`switch${settings.useSystemAccent ? ' on' : ''}`}
                onClick={() => void update({ useSystemAccent: !settings.useSystemAccent })}
                role="switch"
                aria-checked={settings.useSystemAccent}
              >
                <span />
              </button>
            </div>

            <div className="seed-row">
              <button
                className={`seed-choice windows${settings.useSystemAccent ? ' selected' : ''}`}
                onClick={() => void update({ useSystemAccent: true })}
                title="Color de Windows"
              >
                <span style={{ background: accentColor }} />
                <Icon name="desktop_windows" size={14} />
              </button>
              {seedSwatches().map((color) => (
                <button
                  key={color}
                  className={`seed-choice${
                    !settings.useSystemAccent && settings.seedColor === color ? ' selected' : ''
                  }`}
                  style={{ background: color }}
                  onClick={() => void update({ useSystemAccent: false, seedColor: color })}
                  aria-label={`Color ${color}`}
                >
                  {!settings.useSystemAccent && settings.seedColor === color ? (
                    <Icon name="check" size={15} />
                  ) : null}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <span className="settings-icon">
                <Icon name="sd_storage" size={21} />
              </span>
              <div>
                <h2>Almacenamiento local</h2>
                <p>Caché progresiva para empezar a ver al instante.</p>
              </div>
            </div>

            <div className="cache-usage">
              <div className="cache-usage-top">
                <strong>{formatBytes(cache?.bytes ?? 0)}</strong>
                <span>
                  {cache?.limitBytes
                    ? `de ${formatBytes(cache.limitBytes)}`
                    : 'Sin límite de caché'}
                </span>
              </div>
              <div className="cache-bar">
                <span style={{ width: `${cachePercent}%` }} />
              </div>
              <p>
                {cache?.files ?? 0} {cache?.files === 1 ? 'archivo en caché' : 'archivos en caché'}.
                Los originales siempre están en Telegram.
              </p>
            </div>

            <div className="setting-row stack">
              <div className="setting-copy">
                <strong>Límite de caché</strong>
                <span>Las copias completas más antiguas se liberan al llegar al límite.</span>
              </div>
              <div className="limit-options">
                {LIMITS.map((limit) => (
                  <button
                    key={limit.value}
                    className={settings.cacheLimitGb === limit.value ? 'selected' : ''}
                    onClick={() => void update({ cacheLimitGb: limit.value })}
                  >
                    {limit.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-button-row">
              <button className="btn tonal" onClick={() => void api.library.openCacheFolder()}>
                <Icon name="folder_open" size={18} /> Abrir carpeta
              </button>
              <button className="btn text danger-text" onClick={() => setClearOpen(true)}>
                <Icon name="delete_sweep" size={18} /> Vaciar caché
              </button>
            </div>
          </section>

          <section className="settings-card account-card">
            <div className="settings-card-head">
              <span className="settings-icon">
                <Icon name="cloud" size={21} />
              </span>
              <div>
                <h2>Tu canal privado</h2>
                <p>La sesión está cifrada en este PC.</p>
              </div>
            </div>

            <div className="channel-row">
              <span className="settings-icon small">
                <Icon name="lock" size={18} />
              </span>
              <div>
                <strong>{library.channelTitle}</strong>
                <span>
                  {formatBytes(library.totalSize)} · {library.videos.length} vídeos
                </span>
              </div>
              <span className="secure-badge">
                <Icon name="lock" size={13} /> Privado
              </span>
            </div>

            <div className="settings-button-row">
              <button className="btn text" onClick={() => setLogoutOpen(true)}>
                <Icon name="logout" size={18} /> Cerrar sesión
              </button>
              <button className="btn text danger-text" onClick={() => setResetOpen(true)}>
                <Icon name="key_off" size={18} /> Cambiar credenciales API
              </button>
            </div>
          </section>

          <section className="settings-card about-card">
            <div className="settings-card-head">
              <span className="settings-icon">
                <Icon name="auto_awesome" size={21} />
              </span>
              <div>
                <h2>Acerca de TelePlayer</h2>
                <p>Versión {appVersion}</p>
              </div>
            </div>

            <div className="about-features">
              <div>
                <Icon name="cloud_done" size={21} />
                <span>
                  <strong>Backup privado</strong>
                  Tus vídeos viven en tu propio canal de Telegram.
                </span>
              </div>
              <div>
                <Icon name="call_split" size={21} />
                <span>
                  <strong>Sin límite de tamaño</strong>
                  Los archivos que superan el límite de Telegram se dividen en partes y se
                  reconstruyen al reproducir.
                </span>
              </div>
              <div>
                <Icon name="speed" size={21} />
                <span>
                  <strong>Reproducción fluida</strong>
                  La caché progresiva permite empezar a ver mientras llega el resto y buscar en la línea de tiempo.
                </span>
              </div>
              <div>
                <Icon name="shield_lock" size={21} />
                <span>
                  <strong>Conexión directa</strong>
                  MTProto desde tu PC a Telegram. No hay servidores de TelePlayer de por medio.
                </span>
              </div>
            </div>

            <p className="about-legal">
              TelePlayer no está afiliado a Telegram. Telegram es una marca de Telegram FZ-LLC.
              Hecho con cariño para tu videoteca personal.
            </p>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={clearOpen}
        title="Vaciar la caché local"
        message="Se borrarán las copias locales y las cachés parciales de streaming. Los vídeos originales seguirán en tu canal de Telegram y podrás volver a transmitirlos o descargarlos."
        confirmLabel="Vaciar caché"
        icon="delete_sweep"
        danger
        busy={busy}
        onConfirm={() => void clearCache()}
        onClose={() => setClearOpen(false)}
      />

      <ConfirmDialog
        open={logoutOpen}
        title="Cerrar sesión en TelePlayer"
        message="Se cerrará la sesión y se vaciará la caché local de este PC. Tu canal, tus carpetas y tus vídeos permanecerán en Telegram."
        confirmLabel="Cerrar sesión"
        icon="logout"
        danger
        busy={busy}
        onConfirm={() => void logout()}
        onClose={() => setLogoutOpen(false)}
      />

      <ConfirmDialog
        open={resetOpen}
        title="Cambiar credenciales API"
        message="Se eliminarán las credenciales y la sesión actual. Tendrás que volver a iniciar sesión con tu cuenta. Tus vídeos no se tocan."
        confirmLabel="Eliminar credenciales"
        icon="key_off"
        danger
        busy={busy}
        onConfirm={() => void resetCredentials()}
        onClose={() => setResetOpen(false)}
      />
    </div>
  )
}
