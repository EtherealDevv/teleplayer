/**
 * Utilidades compartidas por las dos rutas de transferencia (bloques de
 * descarga y partes de subida). Telegram castiga a los clientes que insisten
 * antes de tiempo: reintentar con un backoff propio un FLOOD_WAIT solo reinicia
 * la cuenta del servidor.
 */

export const MAX_FLOOD_WAIT_MS = 90_000

/** FLOOD_WAIT_N: segundos que pide el servidor, con techo local. */
export function floodWaitMs(error: unknown): number | null {
  const seconds = Number((error as { seconds?: unknown })?.seconds)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_FLOOD_WAIT_MS, Math.round(seconds * 1000))
  }
  const text = String((error as { errorMessage?: string })?.errorMessage ?? error)
  const match = /FLOOD_WAIT_(\d+)/.exec(text)
  if (!match) return null
  return Math.min(MAX_FLOOD_WAIT_MS, Number(match[1]) * 1000 + 500)
}

/** Backoff exponencial con jitter para que varios bloques no reintenten a la vez. */
export function retryDelay(attempt: number, baseMs: number, capMs = 15_000): number {
  const base = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

export function delayWithSignal(
  ms: number,
  signal: AbortSignal,
  message = 'CANCELLED'
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(message))
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout
    const onAbort = (): void => {
      cleanup()
      reject(new Error(message))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
