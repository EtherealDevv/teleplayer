import { Api, TelegramClient } from 'teleproto'
import { generateRandomLong } from 'teleproto/Helpers'
import { getFileInfo } from 'teleproto/Utils'
import { BoundedSemaphore, OrderedWriter } from 'teleproto/network/OrderedWriter'
import bigInt from 'big-integer'
import fs from 'node:fs'
import { once } from 'node:events'

export const FREE_FILE_LIMIT = 2_000_000_000
export const PREMIUM_FILE_LIMIT = 4_000_000_000
const UPLOAD_CONCURRENCY = 16
const DOWNLOAD_PART_SIZE = 512 * 1024

export function fileLimitFor(premium: boolean | undefined): number {
  return premium ? PREMIUM_FILE_LIMIT : FREE_FILE_LIMIT
}

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
            const saved = isLarge
              ? await client._media.savePart(
                  dcId,
                  new Api.upload.SaveBigFilePart({
                    fileId,
                    filePart: index,
                    fileTotalParts: totalParts,
                    bytes: buffer
                  }),
                  controller.signal
                )
              : await client._media.savePart(
                  dcId,
                  new Api.upload.SaveFilePart({
                    fileId,
                    filePart: index,
                    bytes: buffer
                  }),
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

/**
 * Descarga una parte de un mensaje usando varias conexiones en paralelo y
 * escribe los bloques en orden. Antes se pedían bloques de 512 KB uno detrás
 * de otro, lo que dejaba la descarga limitada a una sola conexión.
 */
export async function downloadPartToStream(
  client: TelegramClient,
  message: Api.Message,
  writer: fs.WriteStream,
  signal: AbortSignal,
  onBytes: (bytes: number) => void
): Promise<void> {
  const info = getFileInfo(message)
  const totalBytes = info.size ? info.size.toJSNumber() : 0
  if (totalBytes <= 0) {
    for await (const chunk of client.iterDownload(message, {
      requestSize: DOWNLOAD_PART_SIZE,
      signal
    })) {
      if (!writer.write(chunk)) await once(writer, 'drain')
      onBytes(chunk.length)
    }
    return
  }

  const route = { dcId: info.dcId ?? client.session.dcId }
  const totalParts = Math.max(1, Math.ceil(totalBytes / DOWNLOAD_PART_SIZE))
  const ordered = new OrderedWriter({
    write: async (buffer: Buffer) => {
      if (!writer.write(buffer)) await once(writer, 'drain')
    }
  })
  const download = client._media.opts.download
  const inflight = new BoundedSemaphore(
    Math.max(1, download.sessions * download.inFlight)
  )
  let firstError: unknown
  const tasks: Array<Promise<void>> = []

  for (let index = 0; index < totalParts; index += 1) {
    if (signal.aborted || firstError) break
    await inflight.acquire()
    if (signal.aborted || firstError) {
      inflight.release()
      break
    }
    tasks.push(
      (async () => {
        try {
          const data = await client._media.getFile(
            route.dcId,
            info.location,
            bigInt(index).multiply(DOWNLOAD_PART_SIZE),
            DOWNLOAD_PART_SIZE,
            signal,
            (dc) => {
              route.dcId = dc
            }
          )
          if (firstError) return
          await ordered.write(index, data, (bytes) => onBytes(bytes))
        } catch (error) {
          if (!firstError) firstError = error
        } finally {
          inflight.release()
        }
      })()
    )
  }

  await Promise.all(tasks)
  if (firstError) throw firstError
}
