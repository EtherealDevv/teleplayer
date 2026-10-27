export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const rawIndex = Math.floor(Math.log(bytes) / Math.log(1024))
  const index = Math.max(0, Math.min(units.length - 1, rawIndex))
  const value = bytes / Math.pow(1024, index)
  const digits = index === 0 ? 0 : value >= 100 ? 0 : decimals
  return `${value.toLocaleString('es-ES', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0
  })} ${units[index]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  if (bytesPerSecond < 1) return '< 1 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 10) {
    return value.toLocaleString('es-ES', {
      maximumFractionDigits: 1,
      minimumFractionDigits: 0
    })
  }
  return String(Math.round(value))
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatTimecode(seconds: number): string {
  return formatDuration(seconds).replace('—', '0:00')
}

export function formatClock(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function dayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

export function dayLabel(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  if (sameDay(date, now)) return 'Hoy'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(date, yesterday)) return 'Ayer'
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    })
  }
  return date.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

export function formatChatTime(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  if (sameDay(date, now)) return formatClock(ts)
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
  }
  return date.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit'
  })
}

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .trim()
}

export function formatRelative(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return 'Hoy'
  if (days === 1) return 'Ayer'
  if (days < 7) return `Hace ${days} días`
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
  }
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function initialOf(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase()
}

export function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function progressPercent(value: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, (value / total) * 100))
}

export function idHue(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360
  }
  return hash
}
