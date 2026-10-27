import type { Folder } from '../shared/types'

export const VIDEO_MARK = '[TP1]'
export const FOLDER_MARK = '[TPF1]'

export interface StoredMeta {
  v: 1
  id: string
  /** Original file name (used when saving locally). */
  n: string
  /** Display title. */
  ti: string
  part: number
  parts: number
  size: number
  mime?: string
  duration?: number
  width?: number
  height?: number
  folderId: string | null
  folderName?: string
  addedAt: number
}

const MAX_NAME = 120
const MAX_TITLE = 120

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return clip(base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || name, MAX_TITLE)
}

export function extensionFromFileName(name: string): string {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(name)
  return match ? `.${match[1].toLowerCase()}` : '.bin'
}

export function normalizeTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  return clip(clean, MAX_TITLE)
}

export function normalizeMeta(meta: StoredMeta): StoredMeta {
  return {
    v: 1,
    id: String(meta.id),
    n: clip(String(meta.n || 'video.mp4'), MAX_NAME),
    ti: normalizeTitle(String(meta.ti || titleFromFileName(meta.n || 'video'))),
    part: Math.max(0, Math.floor(meta.part) || 0),
    parts: Math.max(1, Math.floor(meta.parts) || 1),
    size: Math.max(0, Math.floor(meta.size) || 0),
    mime: meta.mime ? String(meta.mime) : undefined,
    duration: Number.isFinite(meta.duration) ? Number(meta.duration) : undefined,
    width: Number.isFinite(meta.width) ? Number(meta.width) : undefined,
    height: Number.isFinite(meta.height) ? Number(meta.height) : undefined,
    folderId: meta.folderId ? String(meta.folderId) : null,
    folderName: meta.folderName ? clip(String(meta.folderName), 60) : undefined,
    addedAt: Number(meta.addedAt) || Date.now()
  }
}

export function videoCaption(metaInput: StoredMeta): string {
  const meta = normalizeMeta(metaInput)
  const partLabel = meta.parts > 1 ? ` · parte ${meta.part + 1}/${meta.parts}` : ''
  const payload: Record<string, unknown> = {
    v: 1,
    id: meta.id,
    n: meta.n,
    ti: meta.ti,
    p: meta.part,
    pc: meta.parts,
    sz: meta.size,
    m: meta.mime,
    d: meta.duration,
    w: meta.width,
    h: meta.height,
    f: meta.folderId,
    fn: meta.folderName,
    t: meta.addedAt
  }
  return `🎬 ${meta.ti}${partLabel}\n${VIDEO_MARK}${JSON.stringify(payload)}`
}

function markIndex(text: string, mark: string): number {
  const prefixed = text.lastIndexOf(`\n${mark}`)
  return prefixed >= 0 ? prefixed + 1 : text.indexOf(mark)
}

export function parseVideoCaption(text: string | undefined | null): StoredMeta | null {
  if (!text) return null
  const index = markIndex(text, VIDEO_MARK)
  if (index < 0) return null
  try {
    const raw = JSON.parse(text.slice(index + VIDEO_MARK.length))
    if (!raw || raw.v !== 1 || typeof raw.id !== 'string') return null
    return normalizeMeta({
      v: 1,
      id: raw.id,
      n: raw.n,
      ti: raw.ti,
      part: raw.p,
      parts: raw.pc,
      size: raw.sz,
      mime: raw.m,
      duration: raw.d,
      width: raw.w,
      height: raw.h,
      folderId: raw.f ?? null,
      folderName: raw.fn,
      addedAt: raw.t
    })
  } catch {
    return null
  }
}

export function folderIndexText(folders: Folder[]): string {
  const payload = {
    v: 1,
    f: folders.map((folder) => ({
      id: folder.id,
      n: folder.name,
      e: folder.emoji,
      c: folder.color,
      t: folder.createdAt
    }))
  }
  return `📚 Carpetas de TelePlayer\n${FOLDER_MARK}${JSON.stringify(payload)}`
}

export function parseFolderIndex(text: string | undefined | null): Folder[] | null {
  if (!text) return null
  const index = markIndex(text, FOLDER_MARK)
  if (index < 0) return null
  try {
    const raw = JSON.parse(text.slice(index + FOLDER_MARK.length))
    if (!raw || raw.v !== 1 || !Array.isArray(raw.f)) return null
    const folders: Folder[] = []
    for (const item of raw.f) {
      if (!item || typeof item.id !== 'string' || typeof item.n !== 'string') continue
      folders.push({
        id: item.id,
        name: clip(String(item.n), 48),
        emoji: typeof item.e === 'string' && item.e.length <= 8 ? item.e : '🎬',
        color: typeof item.c === 'string' ? item.c : '#6750A4',
        createdAt: Number(item.t) || Date.now()
      })
    }
    return folders
  } catch {
    return null
  }
}

export function isVideoFileName(name: string): boolean {
  return /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpg|mpeg|ts|m2ts|3gp|ogv)$/i.test(name)
}

export function mimeForName(name: string): string {
  const ext = extensionFromFileName(name).slice(1)
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    '3gp': 'video/3gpp',
    ogv: 'video/ogg'
  }
  return map[ext] ?? 'application/octet-stream'
}
