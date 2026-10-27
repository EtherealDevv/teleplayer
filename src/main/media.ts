import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface ProbeResult {
  duration?: number
  width?: number
  height?: number
}

let cachedPath: string | null | undefined

function ffprobePath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const candidates = [
    path.join(process.resourcesPath, 'bin', 'ffprobe.exe'),
    path.join(app.getAppPath(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedPath = candidate
        return candidate
      }
    } catch {
      // Try the next candidate.
    }
  }
  cachedPath = null
  return null
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
