// Readers for shared Office files and tables: Excel (.xlsx) sheets as CSV text, PowerPoint
// (.pptx) slide text, Word (.docx) text with headings, lists and tables kept, and a short
// statistics line for CSV / sheets. The zip is read with the strict pack reader (no zip
// bombs: sizes and CRCs checked). Pure apart from mammoth.
import { readZip, type ZipFile } from '../packs/zip-read'
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

/** The sheets of an .xlsx, in workbook order (values as shown before number formats). */
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
  const out: SheetData[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${out.length + 1}`
    const rid = attr(m[0], 'r:id')
    const path = rid ? targets.get(rid) : undefined
    const xml = path ? zip.get(path)?.toString('utf8') : undefined
    if (!xml) continue
    out.push({ name, rows: sheetRows(xml, shared) })
  }
  return out
}

function sheetRows(xml: string, shared: string[]): string[][] {
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
      else if (v !== undefined) value = xmlDecode(v)
      if (col < 1000) row[col] = value
    }
    if (index >= 0 && index < 1_048_576) rows[index] = Array.from(row, (x) => x ?? '')
  }
  return Array.from(rows, (r) => r ?? [])
}

/** Slide text of a .pptx, one block per slide in order. */
export function readPptx(buf: Buffer): string[] {
  const zip = unzip(buf)
  const slides = [...zip.keys()]
    .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  if (!slides.length && !zip.has('ppt/presentation.xml')) throw new Error('not a PowerPoint file')
  return slides.map((m) => {
    const xml = zip.get(m[0])?.toString('utf8') ?? ''
    return xml
      .split(/<\/a:p>/)
      .map((p) => texts(p, 'a:t').trim())
      .filter(Boolean)
      .join('\n')
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
  const width = Math.max(head.length, ...data.map((r) => r.length), 0)
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
      col.min = Math.min(...nums)
      col.max = Math.max(...nums)
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
    const width = Math.max(...rows.map((r) => r.length))
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

export async function docxText(buf: Buffer): Promise<string> {
  const mod = await import('mammoth')
  const mammoth = (mod.default ?? mod) as typeof mod
  const r = await mammoth.convertToHtml(
    { buffer: buf },
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) }
  )
  return htmlToText(r.value)
}
