// Subtitle files (.srt / .vtt) → a transcript with [m:ss] marks (11 T12). Auto-generated
// captions repeat each line as it scrolls ("rolling" captions); repeats are dropped. No
// Electron, no fs.

export interface Cue {
  start: number
  end: number
  text: string
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/

function seconds(m: RegExpExecArray): number {
  const [, h, mi, s, ms] = m
  return Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

const stripTags = (s: string): string =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Cues of an SRT or WebVTT file; [] when it has none. */
export function parseSubtitles(text: string): Cue[] {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .split(/\n{2,}/)
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [a, b] = lines[at].split('-->')
    const ma = TIME.exec(a)
    const mb = TIME.exec(b ?? '')
    if (!ma || !mb) continue
    const body = stripTags(lines.slice(at + 1).join(' '))
    if (body) cues.push({ start: seconds(ma), end: seconds(mb), text: body })
  }
  return cues
}

const stamp = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * Plain transcript, one paragraph about every `every` seconds, each starting with its time.
 * Text a cue repeats from the one before is dropped.
 */
export function transcriptFromCues(cues: Cue[], every = 30, maxChars = 60_000): string {
  const out: string[] = []
  let para: string[] = []
  let paraStart = -1
  let prev = ''
  for (const c of cues) {
    let t = c.text
    if (prev && t.startsWith(prev)) t = t.slice(prev.length).trim()
    else if (prev.endsWith(t)) t = ''
    prev = c.text
    if (!t) continue
    if (paraStart < 0) paraStart = c.start
    para.push(t)
    if (c.end - paraStart >= every) {
      out.push(`[${stamp(paraStart)}] ${para.join(' ')}`)
      para = []
      paraStart = -1
    }
  }
  if (para.length) out.push(`[${stamp(Math.max(0, paraStart))}] ${para.join(' ')}`)
  return out.join('\n').slice(0, maxChars)
}
