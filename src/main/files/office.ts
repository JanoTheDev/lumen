// Readers for shared Office files and tables: Excel (.xlsx) sheets as CSV text (date cells as
// ISO dates), PowerPoint (.pptx) slide text with speaker notes, Word (.docx) text with headings, lists and tables kept, and a short
// statistics line for CSV / sheets. The zip is read with the strict pack reader (no zip
// bombs: sizes and CRCs checked), Word files too before mammoth sees them. Pure apart from
// mammoth.
import { posix } from 'path'
import { readZip, type ZipFile } from '../packs/zip-read'
import { writeZip } from '../docs-out/zip'
import { parseCsv, rowsToCsv, sniffSeparator } from '../docs-out/text'
import { asNumber } from '../docs-out/xlsx'
import { xmlDecode } from '../docs-out/xml'

/** Unpacked size allowed for a shared Office file (the file itself is ≤ 50 MB). */
const OFFICE_LIMITS = { maxBytes: 150 * 1024 * 1024, maxEntries: 20_000 }
/** Rows per sheet sent as text (the stats line covers all of them). */
export const MAX_SHEET_ROWS = 2000

function unzip(buf: Buffer): Map<string, Buffer> {
  const files: ZipFile[] = readZip(buf, OFFICE_LIMITS)
  return new Map(files.map((f) => [f.name.toLowerCase(), f.data]))
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? xmlDecode(m[1]) : undefined
}

/** Text of every <t> (or <a:t>) in a fragment, phonetic runs left out. */
function texts(xml: string, tag = 't'): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let out = ''
  for (let m = re.exec(clean); m; m = re.exec(clean)) out += xmlDecode(m[1])
  return out
}

/** "AB12" → 27 (0-based column). */
export function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export interface SheetData {
  name: string
  rows: string[][]
}

function resolveTarget(target: string): string {
  const t = target.replace(/^\/+/, '')
  return (t.startsWith('xl/') ? t : `xl/${t}`).toLowerCase()
}

/**
 * The sheets of an .xlsx, in workbook order: values before number formats, except that cells
 * with a date or time format are ISO dates / times instead of day numbers.
 */
export function readXlsx(buf: Buffer): SheetData[] {
  const zip = unzip(buf)
  const workbook = zip.get('xl/workbook.xml')?.toString('utf8')
  if (!workbook) throw new Error('not an Excel workbook')
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const targets = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) targets.set(id, resolveTarget(target))
  }
  const sharedXml = zip.get('xl/sharedstrings.xml')?.toString('utf8') ?? ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]))
  const dates: DateCells = {
    styles: dateStyles(zip.get('xl/styles.xml')?.toString('utf8') ?? ''),
    date1904: /<workbookPr\b[^>]*\sdate1904="(?:1|true)"/.test(workbook)
  }
  const out: SheetData[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${out.length + 1}`
    const rid = attr(m[0], 'r:id')
    const path = rid ? targets.get(rid) : undefined
    const xml = path ? zip.get(path)?.toString('utf8') : undefined
    if (!xml) continue
    out.push({ name, rows: sheetRows(xml, shared, dates) })
  }
  return out
}

// ---- dates: Excel keeps them as day numbers with a date number format ----

export type DateKind = 'date' | 'time' | 'datetime'

interface DateCells {
  /** Cell style index (the s attribute) → what its number format shows. */
  styles: Map<number, DateKind>
  date1904: boolean
}

/** Built-in number formats that show dates or times. */
const BUILTIN_DATES: Record<number, DateKind> = {
  14: 'date',
  15: 'date',
  16: 'date',
  17: 'date',
  18: 'time',
  19: 'time',
  20: 'time',
  21: 'time',
  22: 'datetime',
  45: 'time',
  46: 'time',
  47: 'time'
}

/** What a custom number format code shows: a date, a time, both, or (undefined) a number. */
export function formatKind(code: string): DateKind | undefined {
  const c = code
    .split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[[^\]]*\]/g, (m) => (/^\[(h+|m+|s+)\]$/i.test(m) ? m.slice(1, -1) : ''))
  const date = /[dy]|m{3,}/i.test(c) || (/m/i.test(c) && !/[hs]/i.test(c))
  const time = /[hs]/i.test(c)
  return date && time ? 'datetime' : date ? 'date' : time ? 'time' : undefined
}

/** The cell styles of styles.xml whose number format is a date or time. */
export function dateStyles(xml: string): Map<number, DateKind> {
  const custom = new Map<number, DateKind | undefined>()
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'))
    const code = attr(m[0], 'formatCode')
    if (Number.isInteger(id) && code !== undefined) custom.set(id, formatKind(code))
  }
  const out = new Map<number, DateKind>()
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  let i = 0
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0)
    const kind = custom.has(id) ? custom.get(id) : BUILTIN_DATES[id]
    if (kind) out.set(i, kind)
    i++
  }
  return out
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/**
 * An Excel day number as ISO text: "2026-09-30", "14:05:00", "2026-09-30T14:05:00". The 1900
 * system counts the 29 February 1900 that never was (Excel's Lotus bug); the 1904 system starts
 * on 1 January 1904. Null for a number no date can be. Pure.
 */
export function excelDate(serial: number, kind: DateKind, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return null
  let days = Math.floor(serial)
  let secs = Math.round((serial - days) * 86_400)
  if (secs >= 86_400) {
    days++
    secs -= 86_400
  }
  const clock = (h: number): string =>
    `${pad(h)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`
  if (kind === 'time') return clock(Math.floor(secs / 3600) + (serial >= 1 ? days * 24 : 0))
  let date: string
  if (date1904) {
    date = new Date(Date.UTC(1904, 0, 1 + days)).toISOString().slice(0, 10)
  } else {
    if (days === 0) return null
    if (days === 60) date = '1900-02-29'
    else
      date = new Date(Date.UTC(1899, 11, days < 60 ? 31 + days : 30 + days))
        .toISOString()
        .slice(0, 10)
  }
  return kind === 'datetime' ? `${date}T${clock(Math.floor(secs / 3600))}` : date
}

function sheetRows(xml: string, shared: string[], dates?: DateCells): string[][] {
  const rows: string[][] = []
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const index = Number(attr(`<row${r[1]}>`, 'r') ?? rows.length + 1) - 1
    const row: string[] = []
    let next = 0
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = `<c${c[1]}>`
      const ref = attr(head, 'r')
      const col = ref ? colIndex(ref) : next
      next = col + 1
      const body = c[2] ?? ''
      const type = attr(head, 't')
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = texts(body)
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
      else if (v !== undefined) {
        value = xmlDecode(v)
        const kind = !type || type === 'n' ? dates?.styles.get(Number(attr(head, 's'))) : undefined
        if (kind) value = excelDate(Number(value), kind, dates?.date1904) ?? value
      }
      if (col < 1000) row[col] = value
    }
    if (index >= 0 && index < 1_048_576) rows[index] = Array.from(row, (x) => x ?? '')
  }
  return Array.from(rows, (r) => r ?? [])
}

/** The paragraphs of a DrawingML fragment, one line each. */
function paragraphs(xml: string): string {
  return xml
    .split(/<\/a:p>/)
    .map((p) => texts(p, 'a:t').trim())
    .filter(Boolean)
    .join('\n')
}

/** The speaker notes of a slide (the notes page's body placeholder), or "". */
function slideNotes(zip: Map<string, Buffer>, slidePath: string): string {
  const rels = zip.get(slidePath.replace(/([^/]+)$/, '_rels/$1.rels'))?.toString('utf8') ?? ''
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => m[0])
    .find((r) => /\/notesSlide"/.test(r))
  const target = rel && attr(rel, 'Target')
  if (!target) return ''
  const path = target.startsWith('/')
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(slidePath), target))
  const xml = zip.get(path.toLowerCase())?.toString('utf8') ?? ''
  return [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
    .map((m) => m[0])
    .filter((sp) => /<p:ph\b[^>]*\btype="body"/.test(sp))
    .map(paragraphs)
    .filter(Boolean)
    .join('\n')
}

/** Slide text of a .pptx, one block per slide in order, speaker notes after "Notes:". */
export function readPptx(buf: Buffer): string[] {
  const zip = unzip(buf)
  const slides = [...zip.keys()]
    .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  if (!slides.length && !zip.has('ppt/presentation.xml')) throw new Error('not a PowerPoint file')
  return slides.map((m) => {
    const text = paragraphs(zip.get(m[0])?.toString('utf8') ?? '')
    const notes = slideNotes(zip, m[0])
    return notes ? `${text}${text ? '\n' : ''}Notes: ${notes}` : text
  })
}

// ---- tables: a statistics line ----

export interface ColumnStats {
  name: string
  filled: number
  numeric: number
  min?: number
  max?: number
  sum?: number
  mean?: number
  distinct: number
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/** Per-column stats of a table whose first row is the header. Pure. */
export function tableStats(rows: string[][]): { rows: number; columns: ColumnStats[] } {
  const [head = [], ...data] = rows.filter((r) => r.some((c) => c.trim()))
  // Loops, not spreads: a spread of 150k+ values overflows the stack.
  const width = data.reduce((w, r) => Math.max(w, r.length), head.length)
  const columns: ColumnStats[] = []
  for (let i = 0; i < width; i++) {
    const values = data.map((r) => (r[i] ?? '').trim()).filter(Boolean)
    const nums = values
      .map((v) => asNumber(v.replace(/(?<=\d),(?=\d{3}\b)/g, '')))
      .filter((n): n is number => n !== null)
    const col: ColumnStats = {
      name: head[i]?.trim() || `column ${i + 1}`,
      filled: values.length,
      numeric: nums.length,
      distinct: new Set(values).size
    }
    if (nums.length && nums.length >= values.length * 0.8) {
      const sum = nums.reduce((a, b) => a + b, 0)
      col.min = nums.reduce((a, b) => (b < a ? b : a), Infinity)
      col.max = nums.reduce((a, b) => (b > a ? b : a), -Infinity)
      col.sum = round(sum)
      col.mean = round(sum / nums.length)
    }
    columns.push(col)
  }
  return { rows: data.length, columns }
}

export function statsLine(rows: string[][]): string {
  const s = tableStats(rows)
  const cols = s.columns.slice(0, 40).map((c) => {
    const empty = s.rows - c.filled
    const gaps = empty > 0 ? `, ${empty} empty` : ''
    return c.mean !== undefined
      ? `${c.name} (numbers ${c.min}–${c.max}, mean ${c.mean}, sum ${c.sum}${gaps})`
      : `${c.name} (text, ${c.distinct} distinct${gaps})`
  })
  const more = s.columns.length > 40 ? `; ${s.columns.length - 40} more columns` : ''
  return `[table: ${s.rows} data rows × ${s.columns.length} columns; ${cols.join('; ')}${more}]`
}

/** CSV / TSV text with its stats line first. */
export function csvWithStats(text: string): string {
  const rows = parseCsv(text, sniffSeparator(text))
  return `${statsLine(rows)}\n${text}`
}

/** An .xlsx as text: per sheet a stats line and the first rows as CSV. */
export function xlsxText(buf: Buffer): string {
  const sheets = readXlsx(buf)
  if (!sheets.length) return ''
  return sheets
    .map((s) => {
      const cut = s.rows.length > MAX_SHEET_ROWS
      const csv = rowsToCsv(s.rows.slice(0, MAX_SHEET_ROWS), false)
      return `## Sheet "${s.name}"\n${statsLine(s.rows)}\n${csv}${cut ? `[only the first ${MAX_SHEET_ROWS} rows shown]\n` : ''}`
    })
    .join('\n')
}

export function pptxText(buf: Buffer): string {
  return readPptx(buf)
    .map((t, i) => `## Slide ${i + 1}\n${t}`)
    .join('\n\n')
}

// ---- Word: text with structure ----

/** mammoth's HTML as Markdown-ish text: headings, list items and table rows kept. Pure. */
export function htmlToText(html: string): string {
  const cell = (s: string): string =>
    strip(s)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\|/g, '\\|')
      .trim()
  const strip = (s: string): string => xmlDecode(s.replace(/<[^>]+>/g, ''))
  let out = html.replace(/<img\b[^>]*>/g, '')
  out = out.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_, t: string) => {
    const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cell(c[1]))
    )
    if (!rows.length) return ''
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0)
    const line = (r: string[]): string =>
      `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
    return `\n\n${[line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')}\n\n`
  })
  out = out
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g, (_, n: string, t: string) => {
      return `\n\n${'#'.repeat(Number(n))} ${strip(t).trim()}\n\n`
    })
    .replace(/<li\b[^>]*>/g, '\n- ')
    .replace(/<\/(p|li|ul|ol)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
  return strip(out)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A Word file rebuilt from the entries the strict reader checked (count, total size, each
 * entry's real inflated size and CRC), images emptied (they are never read): mammoth's zip
 * library has no size limit, so it never sees the original archive. Throws ZipError on a bomb
 * or a broken zip.
 */
export function checkedDocx(buf: Buffer): Buffer {
  const files = readZip(buf, OFFICE_LIMITS)
  if (!files.some((f) => f.name.toLowerCase() === 'word/document.xml'))
    throw new Error('not a Word document')
  return writeZip(
    files.map((f) => (/^word\/media\//i.test(f.name) ? { name: f.name, data: Buffer.alloc(0) } : f))
  )
}

export async function docxText(buf: Buffer): Promise<string> {
  const checked = checkedDocx(buf)
  const mod = await import('mammoth')
  const mammoth = (mod.default ?? mod) as typeof mod
  const r = await mammoth.convertToHtml(
    { buffer: checked },
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) }
  )
  return htmlToText(r.value)
}
