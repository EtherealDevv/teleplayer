import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface ProbeResult {
  duration?: number
  width?: number
  height?: number
}

let cachedProbePath: string | null | undefined
let cachedFfmpegPath: string | null | undefined

const BINARY_NAMES = {
  ffprobe: process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
  ffmpeg: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
} as const

function resolveBinary(binary: 'ffprobe' | 'ffmpeg'): string | null {
  const name = BINARY_NAMES[binary]
  const pkg = binary === 'ffprobe' ? 'ffprobe-static' : 'ffmpeg-static'
  const candidates = [
    path.join(process.resourcesPath, 'bin', name),
    path.join(app.getAppPath(), 'node_modules', pkg, name),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, name),
    binary === 'ffprobe'
      ? path.join(app.getAppPath(), 'node_modules', pkg, 'bin', process.platform, process.arch, name)
      : ''
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function ffprobePath(): string | null {
  if (cachedProbePath !== undefined) return cachedProbePath
  cachedProbePath = resolveBinary('ffprobe')
  return cachedProbePath
}

function ffmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath
  cachedFfmpegPath = resolveBinary('ffmpeg')
  return cachedFfmpegPath
}

export function probeVideo(file: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const binary = ffprobePath()
    if (!binary) {
      resolve({})
      return
    }
    const child = spawn(
      binary,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-select_streams',
        'v:0',
        file
      ],
      { windowsHide: true }
    )
    let output = ''
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({})
    }, 15000)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 2_000_000) child.kill()
    })
    child.on('error', () => finish({}))
    child.on('close', () => {
      try {
        const data = JSON.parse(output) as {
          format?: { duration?: string }
          streams?: Array<{ width?: number; height?: number }>
        }
        const stream = data.streams?.[0]
        finish({
          duration: Number(data.format?.duration) || undefined,
          width: stream?.width || undefined,
          height: stream?.height || undefined
        })
      } catch {
        finish({})
      }
    })
  })
}

/** Lado del cuadrado de portada. Telegram satura los `thumb` a 320 px. */
export const THUMB_SIZE = 320

/** Por debajo de estos bytes el JPEG es casi liso: probablemente un negro. */
const FLAT_COVER_BYTES = 3500
/** Segundo intento de portada cuando el fotograma 0 es un fundido a negro. */
const COVER_RETRY_SECONDS = 2.5

/**
 * Extrae un fotograma del vídeo y lo guarda como JPEG cuadrado. El fotograma 0
 * es la portada que pide la biblioteca; el recorte centrado evita que las
 * tarjetas cambien de proporción según el vídeo.
 */
export function generateThumbnail(
  file: string,
  outPath: string,
  atSeconds = 0
): Promise<boolean> {
  return new Promise((resolve) => {
    const binary = ffmpegPath()
    if (!binary) {
      resolve(false)
      return
    }
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    } catch {
      resolve(false)
      return
    }
    const child = spawn(
      binary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(Math.max(0, atSeconds)),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=increase,crop=${THUMB_SIZE}:${THUMB_SIZE}`,
        '-q:v',
        '5',
        '-y',
        outPath
      ],
      { windowsHide: true }
    )
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) {
        try {
          fs.rmSync(outPath, { force: true })
        } catch {
          // A locked half-written JPEG is cleaned up on the next attempt.
        }
      }
      resolve(ok)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 20_000)
    child.on('error', () => finish(false))
    child.on('close', (code) => {
      try {
        const stat = fs.statSync(outPath)
        finish(code === 0 && stat.size > 512)
      } catch {
        finish(false)
      }
    })
  })
}

function coverBytes(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Portada de biblioteca. El fotograma 0 es lo que se pide, pero muchos vídeos
 * empiezan con un fundido a negro y la tarjeta quedaría negra: si el JPEG sale
 * casi liso, se prueba otro fotograma a los 2,5 s y se queda el que tenga más
 * detalle. El segundo intento solo cuesta cuando el primero falla.
 */
export async function generateCover(file: string, outPath: string): Promise<boolean> {
  if (!(await generateThumbnail(file, outPath, 0))) return false
  const first = coverBytes(outPath)
  if (first >= FLAT_COVER_BYTES) return true
  const alternative = `${outPath}.alt.jpg`
  const second = await generateThumbnail(file, alternative, COVER_RETRY_SECONDS)
  if (!second) return true
  try {
    if (coverBytes(alternative) > first) {
      fs.rmSync(outPath, { force: true })
      fs.renameSync(alternative, outPath)
    } else {
      fs.rmSync(alternative, { force: true })
    }
  } catch {
    // Si el renombrado falla, la portada del fotograma 0 sigue siendo válida.
    fs.rmSync(alternative, { force: true })
  }
  return true
}

