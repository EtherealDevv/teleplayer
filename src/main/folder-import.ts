import fs from 'node:fs'
import path from 'node:path'
import { isVideoFileName } from './caption'

/** Un vídeo encontrado dentro de una carpeta arrastrada. */
export interface ScannedVideo {
  /** Ruta absoluta en disco. */
  file: string
  /** Subcarpeta relativa a la raíz, con `/` como separador. Vacía si está en la raíz. */
  relativeDir: string
}

export interface FolderScan {
  files: ScannedVideo[]
  ignored: number
  truncated: boolean
}

/**
 * Carpetas que nunca contienen vídeos del usuario y que pueden hacer que un
 * arrastre accidental recorra medio disco.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  'windows',
  'winsxs',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  'recovery',
  'perflogs'
])

const MAX_FILES = 4000
const MAX_DEPTH = 12
const MAX_ENTRIES = 40_000

export async function statSafe(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target)
  } catch {
    return null
  }
}

/**
 * Recorre una carpeta y devuelve los vídeos que contiene, sin seguir enlaces
 * simbólicos ni entrar en carpetas de sistema. El recorrido es iterativo (una
 * pila explícita) para no reventar la pila con árboles profundos.
 */
export async function scanVideoFolder(root: string): Promise<FolderScan> {
  const files: ScannedVideo[] = []
  let ignored = 0
  let truncated = false
  let seen = 0
  const stack: Array<{ dir: string; relative: string; depth: number }> = [
    { dir: root, relative: '', depth: 0 }
  ]

  while (stack.length > 0) {
    if (files.length >= MAX_FILES) {
      truncated = true
      break
    }
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true })
    } catch {
      ignored += 1
      continue
    }

    for (const entry of entries) {
      seen += 1
      if (seen > MAX_ENTRIES) {
        truncated = true
        stack.length = 0
        break
      }
      const name = entry.name
      if (name.startsWith('.')) continue
      const full = path.join(current.dir, name)

      if (entry.isSymbolicLink()) {
        ignored += 1
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) {
          ignored += 1
          continue
        }
        if (current.depth >= MAX_DEPTH) {
          ignored += 1
          continue
        }
        stack.push({
          dir: full,
          relative: current.relative ? `${current.relative}/${name}` : name,
          depth: current.depth + 1
        })
        continue
      }
      if (!entry.isFile()) {
        ignored += 1
        continue
      }
      if (!isVideoFileName(name)) {
        ignored += 1
        continue
      }
      files.push({ file: full, relativeDir: current.relative })
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
    }
  }

  files.sort((a, b) => {
    if (a.relativeDir !== b.relativeDir) return a.relativeDir.localeCompare(b.relativeDir, 'es')
    return a.file.localeCompare(b.file, 'es')
  })
  return { files, ignored, truncated }
}
