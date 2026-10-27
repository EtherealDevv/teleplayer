import fs from 'node:fs'
import path from 'node:path'
import type { StreamProgress, StreamStatus } from '../shared/types'
import { errorText } from './errors'

const CHUNK_SIZE = 512 * 1024
const MANIFEST_VERSION = 1
const PREFETCH_AHEAD = 12
const MIN_PREFETCH_AHEAD = 4
const MAX_PREFETCH_AHEAD = 24
const PREFETCH_CONCURRENCY = 3
const FETCH_ATTEMPTS = 3
const FETCH_RETRY_BASE_MS = 600
const FETCH_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MIN_MS = 12_000
const FETCH_SPLIT_DEPTH = 2
const FETCH_SPLIT_MIN_BYTES = 128 * 1024
const IDLE_CLOSE_MS = 25_000
const PROGRESS_INTERVAL_MS = 250
const MANIFEST_SAVE_MS = 1500

interface Manifest {
  version: number
  totalSize: number
  chunkSize: number
  chunks: number[]
}

export interface StreamSource {
  videoId: string
  filePath: string
  totalSize: number
  mime: string
  /**
   * Debe devolver exactamente `length` bytes a partir de `start`, leyendo
   * directamente de Telegram. La caché progresiva llama a esta función por
   * bloques de 512 KB y guarda cada bloque en disco.
   */
  fetch: (start: number, length: number, signal: AbortSignal) => Promise<Buffer>
  /**
   * Bytes que conviene mantener descargados por delante de la posición de
   * reproducción. TelegramService lo calcula a partir del bitrate medio para
   * que un vídeo con mucho bitrate tenga un colchón de varios segundos.
   */
  prefetchBytes?: number
  onComplete: () => void
}

interface StreamSession {
  source: StreamSource
  handle: fs.promises.FileHandle
  totalChunks: number
  chunks: Set<number>
  inflight: Map<number, Promise<Buffer>>
  prefetchQueue: number[]
  prefetchRunning: number
  prefetchAhead: number
  cachedBytes: number
  complete: boolean
  active: number
  controller: AbortController
  idleTimer: NodeJS.Timeout | null
  persistTimer: NodeJS.Timeout | null
  writeQueue: Promise<void>
  lastEmit: number
  lastBytes: number
  speed: number
  status: StreamStatus
  error?: string
}

function manifestPathFor(filePath: string): string {
  return `${filePath}.tp.json`
}

function chunkLength(totalSize: number, index: number): number {
  return Math.max(0, Math.min(CHUNK_SIZE, totalSize - index * CHUNK_SIZE))
}

function isCancelled(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return text.includes('STREAM_CANCELLED') || text.includes('MediaAbortError') || text.includes('AbortError')
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('STREAM_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(new Error('STREAM_CANCELLED'))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function retryDelay(attempt: number): number {
  const base = FETCH_RETRY_BASE_MS * 2 ** attempt
  // Un poco de jitter evita que varios bloques reintenten exactamente a la vez.
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

function fetchTimeoutFor(length: number): number {
  const scaled = FETCH_TIMEOUT_MS * Math.sqrt(Math.max(0.1, length / CHUNK_SIZE))
  return Math.max(FETCH_TIMEOUT_MIN_MS, Math.min(FETCH_TIMEOUT_MS, Math.round(scaled)))
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('STREAM_CANCELLED'))
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout
    const onAbort = (): void => {
      cleanup()
      reject(new Error('STREAM_CANCELLED'))
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

async function readManifest(filePath: string, totalSize: number): Promise<Set<number> | null> {
  try {
    const raw = await fs.promises.readFile(manifestPathFor(filePath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Manifest>
    if (
      parsed.version !== MANIFEST_VERSION ||
      parsed.totalSize !== totalSize ||
      parsed.chunkSize !== CHUNK_SIZE ||
      !Array.isArray(parsed.chunks)
    ) {
      return null
    }
    const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE))
    const chunks = new Set<number>()
    for (const value of parsed.chunks) {
      const index = Number(value)
      if (Number.isInteger(index) && index >= 0 && index < totalChunks) chunks.add(index)
    }
    return chunks
  } catch {
    return null
  }
}

/**
 * Caché progresiva para reproducir desde la nube.
 *
 * El archivo se crea con su tamaño final y se van escribiendo bloques de
 * 512 KB a medida que el reproductor los pide. El protocolo `tp-media` puede
 * servir cualquier rango ya descargado (o esperar a que llegue) sin necesidad
 * de bajar el vídeo completo. Los bloques descargados se conservan en disco y
 * se reutilizan en la siguiente reproducción.
 */
export class MediaStreamer {
  private sessions = new Map<string, StreamSession>()
  private detached = new Map<string, { bytes: number; filePath: string }>()
  private cacheDir: string
  private onProgress: (state: StreamProgress) => void

  constructor(cacheDir: string, onProgress: (state: StreamProgress) => void) {
    this.cacheDir = cacheDir
    this.onProgress = onProgress
  }

  async prepare(source: StreamSource): Promise<void> {
    if (source.totalSize <= 0) throw new Error('El vídeo no tiene un tamaño válido.')
    const current = this.sessions.get(source.videoId)
    if (
      current &&
      current.source.filePath === source.filePath &&
      current.source.totalSize === source.totalSize
    ) {
      this.clearIdleTimer(current)
      return
    }
    if (current) await this.close(source.videoId, true)

    await fs.promises.mkdir(path.dirname(source.filePath), { recursive: true })
    let handle: fs.promises.FileHandle
    try {
      handle = await fs.promises.open(source.filePath, 'r+')
    } catch {
      handle = await fs.promises.open(source.filePath, 'w+')
    }
    try {
      const stat = await handle.stat()
      if (stat.size !== source.totalSize) await handle.truncate(source.totalSize)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }

    const totalChunks = Math.max(1, Math.ceil(source.totalSize / CHUNK_SIZE))
    const chunks = (await readManifest(source.filePath, source.totalSize)) ?? new Set<number>()
    let cachedBytes = 0
    for (const index of chunks) cachedBytes += chunkLength(source.totalSize, index)
    const prefetchAhead =
      source.prefetchBytes && source.prefetchBytes > 0
        ? Math.max(
            MIN_PREFETCH_AHEAD,
            Math.min(MAX_PREFETCH_AHEAD, Math.ceil(source.prefetchBytes / CHUNK_SIZE))
          )
        : PREFETCH_AHEAD

    const session: StreamSession = {
      source,
      handle,
      totalChunks,
      chunks,
      inflight: new Map(),
      prefetchQueue: [],
      prefetchRunning: 0,
      prefetchAhead,
      cachedBytes,
      complete: false,
      active: 0,
      controller: new AbortController(),
      idleTimer: null,
      persistTimer: null,
      writeQueue: Promise.resolve(),
      lastEmit: 0,
      lastBytes: cachedBytes,
      speed: 0,
      status: 'idle'
    }
    this.sessions.set(source.videoId, session)
    this.detached.delete(source.videoId)

    if (chunks.size >= totalChunks) {
      session.complete = true
      session.status = 'cached'
      await fs.promises.rm(manifestPathFor(source.filePath), { force: true }).catch(() => undefined)
      source.onComplete()
    }
    this.emit(session, true)
  }

  progress(videoId: string): StreamProgress | null {
    const session = this.sessions.get(videoId)
    return session ? this.snapshot(session) : null
  }

  hasSession(videoId: string): boolean {
    return this.sessions.has(videoId)
  }

  isActive(videoId: string): boolean {
    const session = this.sessions.get(videoId)
    return Boolean(session && !session.complete && (session.active > 0 || session.inflight.size > 0))
  }

  info(): { bytes: number; files: number } {
    let bytes = 0
    let files = 0
    for (const session of this.sessions.values()) {
      if (session.complete || session.cachedBytes <= 0) continue
      bytes += session.cachedBytes
      files += 1
    }
    for (const detachedEntry of this.detached.values()) {
      if (detachedEntry.bytes <= 0) continue
      bytes += detachedEntry.bytes
      files += 1
    }
    return { bytes, files }
  }

  async serve(
    source: StreamSource,
    start: number,
    end: number,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    await this.prepare(source)
    let session = this.sessions.get(source.videoId)
    if (!session) {
      // The idle timer may have closed the session between prepare() and
      // this request. Recreate it from the on-disk manifest.
      await this.prepare(source)
      session = this.sessions.get(source.videoId)
    }
    if (!session) throw new Error('No se pudo abrir la caché del vídeo.')
    if (start < 0 || end < start || start >= source.totalSize) {
      throw new Error('Rango de vídeo no válido.')
    }
    const finalEnd = Math.min(end, source.totalSize - 1)
    session.active += 1
    this.clearIdleTimer(session)

    const requestController = new AbortController()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', abortRequest)
      session.active = Math.max(0, session.active - 1)
      this.scheduleIdleClose(session)
      this.emit(session, true)
    }
    const abortRequest = (): void => requestController.abort()
    if (signal) {
      if (signal.aborted) abortRequest()
      else signal.addEventListener('abort', abortRequest, { once: true })
    }

    let offset = start
    let remaining = finalEnd - start + 1

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (requestController.signal.aborted) throw new Error('STREAM_CANCELLED')
          if (remaining <= 0) {
            controller.close()
            release()
            return
          }
          const chunkIndex = Math.floor(offset / CHUNK_SIZE)
          const buffer = await this.getChunk(session, chunkIndex, requestController.signal)
          const within = offset - chunkIndex * CHUNK_SIZE
          const take = Math.min(buffer.length - within, remaining)
          if (take <= 0) throw new Error('La caché del vídeo quedó incompleta.')
          controller.enqueue(new Uint8Array(buffer.subarray(within, within + take)))
          offset += take
          remaining -= take
          this.prefetch(session, Math.floor(offset / CHUNK_SIZE), session.prefetchAhead)
          if (remaining <= 0) {
            controller.close()
            release()
          }
        } catch (error) {
          if (!isCancelled(error)) {
            session.status = 'error'
            session.error = errorText(error)
            this.emit(session, true)
          }
          controller.error(error)
          release()
        }
      },
      cancel: () => {
        requestController.abort()
        signal?.removeEventListener('abort', abortRequest)
        release()
      }
    })
  }

  async close(videoId: string, deletePartial = false): Promise<void> {
    const session = this.sessions.get(videoId)
    if (!session) return
    this.sessions.delete(videoId)
    this.clearIdleTimer(session)
    if (session.persistTimer) {
      clearTimeout(session.persistTimer)
      session.persistTimer = null
    }
    session.prefetchQueue.length = 0
    session.controller.abort()
    await Promise.allSettled([...session.inflight.values()])
    await session.writeQueue.catch(() => undefined)
    await session.handle.close().catch(() => undefined)
    if (deletePartial) {
      this.detached.delete(videoId)
      await fs.promises.rm(session.source.filePath, { force: true }).catch(() => undefined)
      await fs.promises.rm(manifestPathFor(session.source.filePath), { force: true }).catch(() => undefined)
    } else if (!session.complete) {
      if (session.chunks.size === 0) {
        this.detached.delete(videoId)
        await fs.promises.rm(session.source.filePath, { force: true }).catch(() => undefined)
        await fs.promises.rm(manifestPathFor(session.source.filePath), { force: true }).catch(() => undefined)
      } else {
        await this.persist(session).catch(() => undefined)
        this.detached.set(videoId, {
          bytes: session.cachedBytes,
          filePath: session.source.filePath
        })
      }
    } else {
      this.detached.delete(videoId)
    }
    this.onProgress({
      videoId,
      status: session.complete ? 'cached' : 'idle',
      cachedBytes: session.cachedBytes,
      totalBytes: session.source.totalSize,
      speed: 0
    })
  }

  async remove(videoId: string): Promise<void> {
    const detached = this.detached.get(videoId)
    if (detached) {
      this.detached.delete(videoId)
      await fs.promises.rm(detached.filePath, { force: true }).catch(() => undefined)
      await fs.promises.rm(manifestPathFor(detached.filePath), { force: true }).catch(() => undefined)
    }
    await this.close(videoId, true)
  }

  async clear(): Promise<void> {
    for (const videoId of [...this.sessions.keys()]) {
      await this.close(videoId, true)
    }
    for (const detached of this.detached.values()) {
      await fs.promises.rm(detached.filePath, { force: true }).catch(() => undefined)
      await fs.promises.rm(manifestPathFor(detached.filePath), { force: true }).catch(() => undefined)
    }
    this.detached.clear()
    try {
      const entries = await fs.promises.readdir(this.cacheDir)
      for (const entry of entries) {
        if (!entry.endsWith('.tp.json')) continue
        const manifest = path.join(this.cacheDir, entry)
        const file = manifest.slice(0, -'.tp.json'.length)
        await fs.promises.rm(manifest, { force: true }).catch(() => undefined)
        await fs.promises.rm(file, { force: true }).catch(() => undefined)
      }
    } catch {
      // La carpeta puede no existir todavía.
    }
  }

  private async getChunk(
    session: StreamSession,
    index: number,
    signal?: AbortSignal
  ): Promise<Buffer> {
    if (index < 0 || index >= session.totalChunks) throw new Error('Bloque de vídeo fuera de rango.')
    if (session.chunks.has(index)) return this.readChunk(session, index)
    const existing = session.inflight.get(index)
    if (existing) return waitWithSignal(existing, signal)

    const start = index * CHUNK_SIZE
    const length = chunkLength(session.source.totalSize, index)
    const promise = (async () => {
      const data = await this.fetchRangeWithRecovery(
        session.source,
        start,
        length,
        session.controller.signal,
        0
      )
      if (data.length !== length) {
        throw new Error('Telegram devolvió una cantidad de datos distinta de la esperada.')
      }
      const write = session.writeQueue.then(async () => {
        await session.handle.write(data, 0, length, start)
      })
      session.writeQueue = write.then(
        () => undefined,
        () => undefined
      )
      await write
      session.chunks.add(index)
      session.cachedBytes += length
      session.error = undefined
      session.status = 'streaming'
      this.emit(session)
      this.schedulePersist(session)
      if (session.cachedBytes >= session.source.totalSize) await this.complete(session)
      return data
    })()
    session.inflight.set(index, promise)
    promise
      .catch(() => undefined)
      .finally(() => {
        session.inflight.delete(index)
      })
    return waitWithSignal(promise, signal)
  }

  private async readChunk(session: StreamSession, index: number): Promise<Buffer> {
    const length = chunkLength(session.source.totalSize, index)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await session.handle.read(buffer, 0, length, index * CHUNK_SIZE)
    if (bytesRead !== length) throw new Error('La caché del vídeo quedó incompleta.')
    return buffer
  }

  private prefetch(session: StreamSession, from: number, count: number): void {
    if (session.complete || session.controller.signal.aborted) return
    const start = Math.max(0, from)
    const end = Math.min(session.totalChunks, start + count)
    const queue: number[] = []
    for (let index = start; index < end; index += 1) {
      if (session.chunks.has(index) || session.inflight.has(index)) continue
      queue.push(index)
    }
    session.prefetchQueue = queue
    this.pumpPrefetch(session)
  }

  private pumpPrefetch(session: StreamSession): void {
    if (session.complete || session.controller.signal.aborted) {
      session.prefetchQueue.length = 0
      return
    }
    while (session.prefetchRunning < PREFETCH_CONCURRENCY && session.prefetchQueue.length > 0) {
      const index = session.prefetchQueue.shift()
      if (index === undefined) break
      if (session.chunks.has(index) || session.inflight.has(index)) continue
      session.prefetchRunning += 1
      void this.getChunk(session, index)
        .catch(() => undefined)
        .finally(() => {
          session.prefetchRunning = Math.max(0, session.prefetchRunning - 1)
          this.pumpPrefetch(session)
        })
    }
  }

  private async fetchRangeWithRecovery(
    source: StreamSource,
    start: number,
    length: number,
    signal: AbortSignal,
    depth: number
  ): Promise<Buffer> {
    try {
      return await this.fetchRangeWithRetry(source, start, length, signal)
    } catch (error) {
      if (signal.aborted || isCancelled(error)) throw new Error('STREAM_CANCELLED')
      if (depth >= FETCH_SPLIT_DEPTH || length <= FETCH_SPLIT_MIN_BYTES) throw error
      // Si un bloque grande falla de forma persistente, se pide en mitades.
      // Las mitades se piden en paralelo para que una conexión lenta no sume
      // dos esperas completas antes de recuperar la reproducción.
      const firstLength = Math.floor(length / 2)
      const [first, second] = await Promise.all([
        this.fetchRangeWithRecovery(source, start, firstLength, signal, depth + 1),
        this.fetchRangeWithRecovery(
          source,
          start + firstLength,
          length - firstLength,
          signal,
          depth + 1
        )
      ])
      return Buffer.concat([first, second])
    }
  }

  private async fetchRangeWithRetry(
    source: StreamSource,
    start: number,
    length: number,
    signal: AbortSignal
  ): Promise<Buffer> {
    let lastError: unknown
    let lastTimedOut = false
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw new Error('STREAM_CANCELLED')
      const attemptController = new AbortController()
      let timedOut = false
      const abortAttempt = (): void => attemptController.abort()
      signal.addEventListener('abort', abortAttempt, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        attemptController.abort()
      }, fetchTimeoutFor(length))
      try {
        const data = await source.fetch(start, length, attemptController.signal)
        if (data.length !== length) {
          throw new Error('Telegram devolvió una cantidad de datos distinta de la esperada.')
        }
        return data
      } catch (error) {
        lastError = error
        lastTimedOut = timedOut
        if (signal.aborted) throw new Error('STREAM_CANCELLED')
        // Si un bloque grande agota el tiempo, no tiene sentido repetir la
        // misma petición: se deja que fetchRangeWithRecovery lo divida en
        // rangos más pequeños. En el tamaño mínimo sí se reintenta.
        if (timedOut && length > FETCH_SPLIT_MIN_BYTES) {
          throw new Error('TIMEOUT: la conexión con Telegram tardó demasiado en responder.')
        }
        // Si el abort no vino de cerrar la sesión, lo tratamos como un fallo
        // transitorio de la petición y dejamos que el reintento lo resuelva.
        if (attempt < FETCH_ATTEMPTS - 1) {
          await delayWithSignal(retryDelay(attempt), signal)
        }
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abortAttempt)
      }
    }
    if (lastTimedOut) {
      throw new Error('TIMEOUT: la conexión con Telegram tardó demasiado en responder.')
    }
    if (isCancelled(lastError)) {
      throw new Error('La conexión con Telegram se interrumpió.')
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async complete(session: StreamSession): Promise<void> {
    if (session.complete) return
    session.complete = true
    session.status = 'cached'
    session.speed = 0
    if (session.persistTimer) {
      clearTimeout(session.persistTimer)
      session.persistTimer = null
    }
    await fs.promises.rm(manifestPathFor(session.source.filePath), { force: true }).catch(() => undefined)
    session.source.onComplete()
    this.emit(session, true)
  }

  private emit(session: StreamSession, force = false): void {
    const now = Date.now()
    if (!force && now - session.lastEmit < PROGRESS_INTERVAL_MS) return
    const elapsed = Math.max(0.25, (now - session.lastEmit) / 1000)
    if (session.lastEmit > 0) {
      session.speed = Math.max(0, (session.cachedBytes - session.lastBytes) / elapsed)
    }
    session.lastEmit = now
    session.lastBytes = session.cachedBytes
    if (session.complete) session.speed = 0
    this.onProgress(this.snapshot(session))
  }

  private snapshot(session: StreamSession): StreamProgress {
    const status: StreamStatus = session.error
      ? 'error'
      : session.complete
        ? 'cached'
        : session.active > 0 || session.inflight.size > 0
          ? 'streaming'
          : 'idle'
    return {
      videoId: session.source.videoId,
      status,
      cachedBytes: session.cachedBytes,
      totalBytes: session.source.totalSize,
      speed: session.speed,
      error: session.error
    }
  }

  private schedulePersist(session: StreamSession): void {
    if (session.persistTimer) clearTimeout(session.persistTimer)
    session.persistTimer = setTimeout(() => {
      session.persistTimer = null
      void this.persist(session).catch(() => undefined)
    }, MANIFEST_SAVE_MS)
  }

  private async persist(session: StreamSession): Promise<void> {
    if (session.complete || session.chunks.size === 0) return
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      totalSize: session.source.totalSize,
      chunkSize: CHUNK_SIZE,
      chunks: [...session.chunks].sort((a, b) => a - b)
    }
    await fs.promises.writeFile(
      manifestPathFor(session.source.filePath),
      JSON.stringify(manifest),
      'utf8'
    )
  }

  private scheduleIdleClose(session: StreamSession): void {
    this.clearIdleTimer(session)
    if (session.active > 0) return
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.active > 0) return
      session.controller.abort()
      void this.close(session.source.videoId).catch(() => undefined)
    }, IDLE_CLOSE_MS)
  }

  private clearIdleTimer(session: StreamSession): void {
    if (!session.idleTimer) return
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
}
