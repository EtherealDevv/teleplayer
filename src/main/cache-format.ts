/**
 * Formato en disco de la caché progresiva. Lo comparten `MediaStreamer`
 * (escritura) y `AppStore` (limpieza y contabilidad), así que los valores viven
 * en un solo sitio: si cambian, cambian para los dos a la vez.
 */

/** Bloque de descarga y de escritura. Telegram exige múltiplos de 4 KB. */
export const CHUNK_SIZE = 512 * 1024

/** Versión del manifiesto. Un manifiesto de otra versión se descarta. */
export const MANIFEST_VERSION = 1

/** Sufijo del manifiesto que acompaña a cada archivo a medio descargar. */
export const MANIFEST_SUFFIX = '.tp.json'

export function manifestPathFor(filePath: string): string {
  return `${filePath}${MANIFEST_SUFFIX}`
}
