// What a shared file becomes in a model request: PDFs as provider document blocks, images as
// image blocks, Word / text / Markdown / CSV as fenced, capped and redacted text. The file is
// checked again when it is read (it may have changed since the drop).
import { readFile } from 'fs/promises'
import type { ToolContent } from '../ai/providers/types'
import { redactForModel } from '../actions/redact'
import { csvWithStats, docxText, pptxText, xlsxText } from './office'
import { checkDroppedPath, type SharedFile } from './store'

/** Text sent per file (~25k tokens). */
export const MAX_TEXT_CHARS = 100_000
/** Anthropic caps a request at 32 MB and base64 adds a third. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024
/** Anthropic's per-image limit is 5 MB; larger images are scaled down first. */
export const MAX_IMAGE_BYTES = 3_750_000
const MAX_IMAGE_EDGE = 2000

export interface LoadOptions {
  /** false: the provider takes no document blocks (local servers). */
  pdf: boolean
  /** Scales an image down to fit; null when it cannot. Defaults to Electron's nativeImage. */
  shrink?: (buf: Buffer) => Promise<Buffer | null>
}

/** File text as the model sees it: fenced, labelled, untrusted. */
export function fenced(f: Pick<SharedFile, 'id' | 'name' | 'kind'>, body: string): string {
  const clean = body.replace(/<\/?file\b[^>]*>/gi, '')
  const name = f.name.replace(/["<>]/g, '')
  return `<file id="${f.id}" name="${name}" kind="${f.kind}">\n${clean}\n</file>`
}

/** Decodes text with or without a BOM (UTF-8, UTF-16 LE/BE). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2))
    le.swap16()
    return le.toString('utf16le')
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

/** Capped and redacted (keys, cards, IBANs and the like become `[redacted:<kind>]`). */
export function prepareText(text: string, max = MAX_TEXT_CHARS): string {
  const cut = text.length > max
  const body = redactForModel(cut ? text.slice(0, max) : text)
  return cut ? `${body}\n[cut: only the first ${max.toLocaleString('en-US')} characters]` : body
}

async function nativeShrink(buf: Buffer): Promise<Buffer | null> {
  try {
    const { nativeImage } = await import('electron')
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
    const out = img
      .resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
      .toJPEG(85)
    return out.byteLength <= MAX_IMAGE_BYTES ? out : null
  } catch {
    return null
  }
}

const KIND_LABEL: Partial<Record<SharedFile['kind'], string>> = {
  docx: 'Word',
  sheet: 'Excel',
  slides: 'PowerPoint',
  text: 'text'
}

/** Word with headings, lists and tables; Excel sheets and CSV with a stats line; slide text. */
export async function fileText(f: Pick<SharedFile, 'kind' | 'name'>, buf: Buffer): Promise<string> {
  if (f.kind === 'docx') return docxText(buf)
  if (f.kind === 'sheet') return xlsxText(buf)
  if (f.kind === 'slides') return pptxText(buf)
  const text = decodeText(buf)
  return /\.(csv|tsv)$/i.test(f.name) ? csvWithStats(text) : text
}

const note = (f: SharedFile, text: string): ToolContent[] => [
  { type: 'text', text: fenced(f, `[${text}]`) }
]

/** The file's content blocks. Problems come back as a text note, never as a throw. */
export async function loadContent(f: SharedFile, opts: LoadOptions): Promise<ToolContent[]> {
  const checked = await checkDroppedPath(f.path)
  if (!checked.ok) return note(f, `The file can no longer be read: ${checked.error}`)
  if (f.kind === 'pdf' && !opts.pdf)
    return note(f, 'PDF not sent: the local model cannot read PDFs. A cloud model can.')
  if (f.kind === 'pdf' && checked.size > MAX_PDF_BYTES)
    return note(f, 'PDF not sent: it is over 20 MB, too big for one request.')
  let buf: Buffer
  try {
    buf = await readFile(checked.path)
  } catch {
    return note(f, 'The file could not be read.')
  }
  if (f.kind === 'pdf')
    return [
      { type: 'text', text: fenced(f, '[attached as a PDF document]') },
      {
        type: 'document',
        name: f.name,
        base64: buf.toString('base64'),
        mediaType: 'application/pdf'
      }
    ]
  if (f.kind === 'image') {
    let mediaType: 'image/png' | 'image/jpeg' = f.name.toLowerCase().endsWith('.png')
      ? 'image/png'
      : 'image/jpeg'
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      const small = await (opts.shrink ?? nativeShrink)(buf)
      if (!small) return note(f, 'Image not sent: it is too large.')
      buf = small
      mediaType = 'image/jpeg'
    }
    return [
      { type: 'text', text: fenced(f, '[attached as an image]') },
      { type: 'image', base64: buf.toString('base64'), mediaType }
    ]
  }
  let text: string
  try {
    text = await fileText(f, buf)
  } catch {
    return note(
      f,
      `The ${KIND_LABEL[f.kind] ?? ''} file could not be read (damaged or password protected).`
    )
  }
  if (!text.trim()) return note(f, 'The file has no text.')
  return [{ type: 'text', text: fenced(f, prepareText(text)) }]
}
