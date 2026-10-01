// Pure formatting for the Home Notes, dictation history and stats (04 T44-T46).
import type { DictationHistoryEntry, Note } from '@shared/dictation-history'

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Mar". */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = new Date(t)
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** "45 s", "12 min", "2 h 5 min". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** "notepad" from "notepad.exe"; "" stays "". */
export function appLabel(process: string): string {
  return process.replace(/\.exe$/i, '')
}

export function historyMeta(e: DictationHistoryEntry, now = Date.now()): string {
  const parts = [ago(e.t, now)]
  const app = appLabel(e.app)
  if (app) parts.push(app)
  parts.push(plural(e.words, 'word'))
  if (e.style) parts.push(e.style)
  if (!e.ok) parts.push('not typed')
  return parts.join(' · ')
}

/** The transcript, when cleanup changed it. */
export function heardText(e: DictationHistoryEntry): string | null {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  return norm(e.raw) && norm(e.raw) !== norm(e.text) ? e.raw : null
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const VIA_LABEL: Record<Note['via'], string> = {
  voice: 'by voice',
  scratchpad: 'dictated, no text field',
  web: 'from the web',
  manual: ''
}

export function noteMeta(n: Note, now = Date.now()): string {
  const parts = [ago(n.updated ?? n.t, now)]
  const via = VIA_LABEL[n.via]
  if (via) parts.push(via)
  const src = n.source?.title || hostOf(n.source?.url) || n.source?.app
  if (src) parts.push(src)
  return parts.join(' · ')
}
