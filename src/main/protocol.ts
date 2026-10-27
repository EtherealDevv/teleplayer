import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { AppStore } from './store'
import { mimeForName } from './caption'

const VIDEO_HOST = 'video'
const THUMB_HOST = 'thumb'

export type MediaStreamHandler = (videoId: string, request: Request) => Promise<Response>

let streamHandler: MediaStreamHandler | null = null

/**
 * TelegramService se crea después de registrar el protocolo. Este enlace
 * permite que `tp-media://video/...` sirva vídeos que todavía no están
 * descargados por completo, pidiendo los rangos bajo demanda.
 */
export function setMediaStreamHandler(handler: MediaStreamHandler | null): void {
  streamHandler = handler
}

export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startRaw, endRaw] = match
  let start = startRaw ? Number(startRaw) : NaN
  let end = endRaw ? Number(endRaw) : NaN
  if (Number.isNaN(start) && Number.isNaN(end)) return null
  if (Number.isNaN(start)) {
    const suffix = end
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    if (!Number.isFinite(start) || start < 0) return null
    if (Number.isNaN(end) || end >= size) end = size - 1
  }
  if (start > end || start >= size) return null
  return { start, end }
}

function headersForFile(file: string): Headers {
  const headers = new Headers()
  headers.set('Content-Type', mimeForName(file))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Cache-Control', 'no-store')
  return headers
}

export function registerMediaProtocol(store: AppStore): void {
  protocol.handle('tp-media', async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!/^[a-zA-Z0-9-]{8,72}$/.test(id)) {
        return new Response('Not found', { status: 404 })
      }

      if (url.hostname === THUMB_HOST) {
        const thumb = store.getThumbPath(id)
        if (!thumb || !fs.existsSync(thumb)) return new Response('Not found', { status: 404 })
        const data = await fs.promises.readFile(thumb)
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }

      if (url.hostname !== VIDEO_HOST) return new Response('Not found', { status: 404 })
      const file = store.getCacheFile(id)
      if (!file) {
        if (streamHandler) return await streamHandler(id, request)
        return new Response('Not found', { status: 404 })
      }
      const stat = await fs.promises.stat(file)
      const size = stat.size
      const range = parseRange(request.headers.get('range'), size)
      const headers = headersForFile(file)
      headers.set('Content-Length', String(range ? range.end - range.start + 1 : size))

      if (request.method === 'HEAD') {
        if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        return new Response(null, { status: range ? 206 : 200, headers })
      }

      if (request.headers.get('range') && !range) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${size}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      const stream = fs.createReadStream(
        file,
        range ? { start: range.start, end: range.end } : undefined
      )
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: range ? 206 : 200,
        headers
      })
    } catch (error) {
      console.error('tp-media error', error)
      return new Response('Internal error', { status: 500 })
    }
  })
}

export function contentTypeForVideo(file: string): string {
  const ext = path.extname(file).toLowerCase()
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.ts': 'video/mp2t'
  }
  return map[ext] ?? 'application/octet-stream'
}
