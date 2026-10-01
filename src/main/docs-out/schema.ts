// What a made file contains, independent of its format: a title and blocks (headings,
// paragraphs, lists, tables). The model fills it (create_file tool, or a structured reply in
// answer mode); the renderers turn it into docx / xlsx / csv / md / txt / html / pdf.
// Strict-subset schema: no optional fields, no unions, no numeric bounds (agent-mode/tools.ts).
import { z } from 'zod'

export const DOC_FORMATS = ['docx', 'xlsx', 'csv', 'md', 'txt', 'html', 'pdf'] as const
export type DocFormat = (typeof DOC_FORMATS)[number]

export const PLACES = ['default', 'documents', 'desktop', 'downloads', 'next_to_source'] as const
export type Place = (typeof PLACES)[number]

export const blockSchema = z.object({
  kind: z.enum(['heading', 'paragraph', 'bullets', 'numbered', 'table']),
  text: z
    .string()
    .describe('heading / paragraph: the text (**bold** allowed). "" for lists and tables.'),
  level: z.number().int().describe('heading: 1, 2 or 3. 0 for other blocks.'),
  items: z.array(z.string()).describe('bullets / numbered: one entry per item. [] otherwise.'),
  rows: z
    .array(z.array(z.string()))
    .describe('table: rows of cells, the first row is the header. [] otherwise.')
})

export const docContentSchema = z.object({
  title: z.string().describe('Document title ("" for none; spreadsheets and CSV ignore it).'),
  blocks: z.array(blockSchema)
})

export const createFileInput = z.object({
  format: z
    .enum(DOC_FORMATS)
    .describe(
      'docx: Word; xlsx: Excel (each table is a sheet); csv: the first table; md, txt, html; pdf: a printable page.'
    ),
  name: z.string().describe('File name without folder or extension ("Trip budget").'),
  title: docContentSchema.shape.title,
  blocks: docContentSchema.shape.blocks,
  place: z
    .enum(PLACES)
    .describe(
      'default: Documents\\Lumen. next_to_source: the folder of sourceFileId (the file it was made from). Use what the user said ("on my desktop").'
    ),
  sourceFileId: z
    .string()
    .describe('Id of the shared file this was made from, or "" when there is none.'),
  replace: z
    .boolean()
    .describe(
      'true only when the user explicitly asked to replace an existing file of that name; the user is asked first. Else false: a new name is picked.'
    )
})

export type Block = z.infer<typeof blockSchema>
export type DocContent = z.infer<typeof docContentSchema>
export type CreateFileInput = z.infer<typeof createFileInput>

export const EXT: Record<DocFormat, string> = {
  docx: '.docx',
  xlsx: '.xlsx',
  csv: '.csv',
  md: '.md',
  txt: '.txt',
  html: '.html',
  pdf: '.pdf'
}

export const MAX_BLOCKS = 2000
export const MAX_ROWS = 50_000
export const MAX_COLS = 200
export const MAX_CELL = 32_000
const MAX_TEXT = 100_000

const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.slice(0, n) : '')

/** Clamped and cleaned (a model may send odd shapes when a provider is not strict). */
export function normalizeDoc(raw: { title?: unknown; blocks?: unknown }): DocContent {
  const blocks: Block[] = []
  const list = Array.isArray(raw.blocks) ? raw.blocks : []
  for (const b of list.slice(0, MAX_BLOCKS)) {
    if (!b || typeof b !== 'object') continue
    const o = b as Record<string, unknown>
    const kind = blockSchema.shape.kind.safeParse(o.kind)
    if (!kind.success) continue
    const level = typeof o.level === 'number' ? Math.min(3, Math.max(1, Math.round(o.level))) : 1
    const items = Array.isArray(o.items) ? o.items.map((i) => clip(i, MAX_TEXT)) : []
    const rows = Array.isArray(o.rows)
      ? o.rows
          .slice(0, MAX_ROWS)
          .filter(Array.isArray)
          .map((r) =>
            (r as unknown[]).slice(0, MAX_COLS).map((c) => clip(String(c ?? ''), MAX_CELL))
          )
      : []
    blocks.push({
      kind: kind.data,
      text: clip(o.text, MAX_TEXT),
      level: kind.data === 'heading' ? level : 0,
      items: kind.data === 'bullets' || kind.data === 'numbered' ? items : [],
      rows: kind.data === 'table' ? rows : []
    })
  }
  return { title: clip(raw.title, 300).trim(), blocks }
}

/** The tables of a document, each with the heading right before it (a sheet name). */
export function tablesOf(doc: DocContent): { name: string; rows: string[][] }[] {
  const out: { name: string; rows: string[][] }[] = []
  let heading = ''
  for (const b of doc.blocks) {
    if (b.kind === 'heading') heading = b.text
    else if (b.kind === 'table' && b.rows.length) {
      out.push({ name: heading, rows: b.rows })
      heading = ''
    }
  }
  return out
}

/** Plain text runs: `**bold**` marks split out. */
export function runs(text: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false })
    out.push({ text: m[1], bold: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false })
  return out
}

export const plain = (text: string): string => text.replace(/\*\*(.+?)\*\*/g, '$1')
