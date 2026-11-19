import { createHash } from 'node:crypto'
import fs from 'node:fs'

/**
 * Huella de contenido para no volver a subir un archivo renombrado. Se leen
 * solo 256 KB de la cabeza y 256 KB de la cola: dos vídeos distintos que
 * coincidan en tamaño y en ambos extremos son, en la práctica, el mismo
 * archivo. Leer el archivo entero costaría gigas por importación.
 */
const SAMPLE_BYTES = 256 * 1024

export interface FileFingerprint {
  size: number
  hash: string
}

export async function fingerprintFile(file: string): Promise<FileFingerprint | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() || stat.size <= 0) return null
    handle = await fs.promises.open(file, 'r')
    const sample = Math.min(SAMPLE_BYTES, stat.size)
    const head = Buffer.alloc(sample)
    await handle.read(head, 0, sample, 0)
    const tail = Buffer.alloc(sample)
    await handle.read(tail, 0, sample, Math.max(0, stat.size - sample))
    const hash = createHash('sha256')
      .update(String(stat.size))
      .update(head)
      .update(tail)
      .digest('hex')
    return { size: stat.size, hash }
  } catch {
    // Un archivo que desaparece o no se deja leer no bloquea la importación:
    // se queda sin huella y la comprobación por nombre y tamaño sigue en pie.
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
