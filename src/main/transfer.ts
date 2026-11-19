import { Api, TelegramClient } from 'teleproto'
import { generateRandomLong } from 'teleproto/Helpers'
import fs from 'node:fs'
import { delayWithSignal, floodWaitMs, retryDelay } from './retry'

export const FREE_FILE_LIMIT = 2_000_000_000
export const PREMIUM_FILE_LIMIT = 4_000_000_000
const UPLOAD_CONCURRENCY = 16
const UPLOAD_MAX_ATTEMPTS = 5
const UPLOAD_RETRY_BASE_MS = 800

export function fileLimitFor(premium: boolean | undefined): number {
  return premium ? PREMIUM_FILE_LIMIT : FREE_FILE_LIMIT
}

/**
 * Mismo criterio que `getAppropriatedPartSize` de teleproto (el que usan los
 * clientes de referencia): 128 KB hasta 100 MB, 256 KB hasta 750 MB y 512 KB
 * por encima. Partes más pequeñas que 128 KB no caben en `upload.saveFilePart`
 * sin disparar el número de peticiones.
 */
export function uploadPartSizeFor(bytes: number): number {
  if (bytes < 100 * 1024 * 1024) return 128 * 1024
  if (bytes < 750 * 1024 * 1024) return 256 * 1024
  return 512 * 1024
}

export interface UploadRangeOptions {
  client: TelegramClient
  filePath: string
  offset: number
  length: number
  name: string
  onProgress: (uploadedBytes: number) => void
  signal?: AbortSignal
}

/**
 * Una parte de subida se puede perder por un corte de red, un timeout o un
 * FLOOD_WAIT del servidor. Reintentarla es barato: la parte siguiente todavía
 * no ha salido. Antes, el primer fallo de una parte abortaba el archivo entero
 * y la importación se daba por perdida.
 */
async function savePartWithRetry(
  save: () => Promise<boolean | undefined>,
  signal: AbortSignal
): Promise<boolean | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await save()
    } catch (error) {
      if (signal.aborted) throw error
      if (attempt >= UPLOAD_MAX_ATTEMPTS - 1) throw error
      const flood = floodWaitMs(error)
      const wait = flood ?? retryDelay(attempt, UPLOAD_RETRY_BASE_MS)
      await delayWithSignal(wait, signal, 'UPLOAD_CANCELLED')
    }
  }
}

/**
 * Sube un rango del archivo directamente desde el disco, sin copiarlo antes a
 * un temporal. Usa el mismo tamaño de parte y los mismos DC de subida que
 * Teleproto, pero permite paralelizar varias partes y reportar bytes reales.
 */
export async function uploadRange({
  client,
  filePath,
  offset,
  length,
  name,
  onProgress,
  signal
}: UploadRangeOptions): Promise<Api.InputFile | Api.InputFileBig> {
  if (length <= 0) throw new Error('El archivo está vacío.')
  const isLarge = length > 10 * 1024 * 1024
  const partSize = uploadPartSizeFor(length)
  const totalParts = Math.max(1, Math.ceil(length / partSize))
  const fileId = generateRandomLong(true)
  const dcId = client.session.dcId
  const handle = await fs.promises.open(filePath, 'r')
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }

  let nextPart = 0
  let uploaded = 0
  let firstError: unknown
  const workerCount = Math.min(UPLOAD_CONCURRENCY, totalParts)

  try {
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!controller.signal.aborted) {
          const index = nextPart
          nextPart += 1
          if (index >= totalParts) return
          const start = index * partSize
          const size = Math.min(partSize, length - start)
          const buffer = Buffer.allocUnsafe(size)
          try {
            const { bytesRead } = await handle.read(buffer, 0, size, offset + start)
            if (bytesRead !== size) {
              throw new Error('No se pudo leer una parte del archivo. ¿Se movió o cambió?')
            }
            const saved = await savePartWithRetry(
              () =>
                isLarge
                  ? client._media.savePart(
                      dcId,
                      new Api.upload.SaveBigFilePart({
                        fileId,
                        filePart: index,
                        fileTotalParts: totalParts,
                        bytes: buffer
                      }),
                      controller.signal
                    )
                  : client._media.savePart(
                      dcId,
                      new Api.upload.SaveFilePart({
                        fileId,
                        filePart: index,
                        bytes: buffer
                      }),
                      controller.signal
                    ),
              controller.signal
            )
            if (saved === false) throw new Error('Telegram rechazó una parte del archivo.')
            uploaded += size
            onProgress(uploaded)
          } catch (error) {
            if (!firstError) {
              firstError = error
              controller.abort()
            }
            return
          }
        }
      })
    )
  } finally {
    signal?.removeEventListener('abort', abort)
    await handle.close()
  }

  if (firstError) throw firstError
  if (signal?.aborted) throw new Error('UPLOAD_CANCELLED')
  return isLarge
    ? new Api.InputFileBig({ id: fileId, parts: totalParts, name })
    : new Api.InputFile({ id: fileId, parts: totalParts, name, md5Checksum: '' })
}
