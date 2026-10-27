const ALIGN = 4096
const BLOCK = 1024 * 1024
const MIN_REQUEST = 4 * 1024
const MAX_REQUEST = 512 * 1024
// Telegram exige que offset y limit sean múltiplos de 4 KB, que limit divida
// exactamente 1 MB y que la petición no cruce el límite de un bloque de 1 MB
// del archivo. Estos son todos los límites válidos hasta 1 MB.
const VALID_LIMITS = [
  4 * 1024,
  8 * 1024,
  16 * 1024,
  32 * 1024,
  64 * 1024,
  128 * 1024,
  256 * 1024,
  512 * 1024,
  1024 * 1024
]

export interface StreamRangeRequest {
  offset: number
  limit: number
}

/**
 * Divide un rango local de una parte en peticiones válidas para
 * upload.getFile. Las peticiones pueden empezar hasta 4 KB antes del rango
 * pedido y terminar después; el llamador recorta los bytes sobrantes.
 */
export function planPartRange(
  localStart: number,
  localEnd: number,
  partSize: number,
  maxRequest = MAX_REQUEST
): StreamRangeRequest[] {
  const end = Math.min(localEnd, partSize)
  if (partSize <= 0 || end <= 0) return []

  const max = Math.max(MIN_REQUEST, Math.min(maxRequest, BLOCK))
  let cursor = Math.max(0, Math.floor(localStart / ALIGN) * ALIGN)
  const requests: StreamRangeRequest[] = []

  while (cursor < end) {
    const blockEnd = (Math.floor(cursor / BLOCK) + 1) * BLOCK
    const available = Math.min(partSize, blockEnd) - cursor
    if (available <= 0) break

    const cap = Math.min(max, available)
    const desired = Math.max(MIN_REQUEST, end - cursor)
    let limit = VALID_LIMITS.find((value) => value >= desired && value <= cap)
    if (limit === undefined) {
      limit = MIN_REQUEST
      for (const value of VALID_LIMITS) {
        if (value <= cap && value <= max) limit = value
      }
    }

    requests.push({ offset: cursor, limit })
    cursor += limit
    if (requests.length > 100000) {
      throw new Error('Demasiados rangos para una parte del vídeo.')
    }
  }

  return requests
}

/**
 * Lee un rango global del vídeo repartiéndolo entre sus partes. Cada parte es
 * un archivo independiente en Telegram, así que los offsets y límites se
 * calculan en coordenadas locales de esa parte.
 */
export async function fetchStreamRangeFromParts<T extends { start: number; size: number }>(
  parts: readonly T[],
  start: number,
  length: number,
  fetchPart: (part: T, offset: number, limit: number) => Promise<Buffer>,
  signal?: AbortSignal
): Promise<Buffer> {
  if (length < 0) throw new Error('Rango de vídeo no válido.')
  if (length === 0) return Buffer.alloc(0)

  const end = start + length
  const buffers: Buffer[] = []
  let cursor = start

  for (const part of parts) {
    if (cursor >= end) break
    if (end <= part.start) break
    const partEnd = part.start + part.size
    if (cursor >= partEnd) continue

    const localStart = Math.max(0, cursor - part.start)
    const localEnd = Math.min(part.size, end - part.start)
    if (localEnd <= localStart) {
      cursor = Math.max(cursor, partEnd)
      continue
    }

    for (const request of planPartRange(localStart, localEnd, part.size)) {
      if (signal?.aborted) throw new Error('STREAM_CANCELLED')
      const data = await fetchPart(part, request.offset, request.limit)
      const from = Math.max(0, localStart - request.offset)
      const to = Math.min(data.length, localEnd - request.offset)
      if (to > from) buffers.push(data.subarray(from, to))

      if (data.length < request.limit && request.offset + data.length < localEnd) {
        throw new Error('La descarga desde Telegram quedó incompleta.')
      }
      if (request.offset + data.length >= localEnd) break
    }

    cursor = part.start + localEnd
  }

  const result = Buffer.concat(buffers)
  if (result.length !== length) {
    throw new Error('No se pudo leer el rango solicitado del vídeo.')
  }
  return result
}
