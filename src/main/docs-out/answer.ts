// "Make a Word doc of …", "convert this csv to Excel", "summarize this PDF into a one-page
// Word doc", "turn this into a table", then "open it" / "show it in Explorer". Runs ahead of the
// answer pipeline (interceptDocs): the file under the pointer is shared first, the shared files
// the request is about are read, CSV ↔ Excel is converted locally, anything else is written by
// the model as blocks (docs-out/schema.ts) and saved by createDocument (checks, policy, audit).
import { z } from 'zod'
import type { ModelResponse } from '@shared/types'
import { log } from '../logger'
import { parseJsonAs } from '../ai/json'
import { UNTRUSTED_CONTENT_RULE } from '../ai/prompts/untrusted'
import { getProvider } from '../ai/providers'
import { newTaskId } from '../actions/policy'
import { beginScope, endScope, isAbortError } from '../query/cancel'
import { armEscape, disarmEscape } from '../agent/escape'
import { setStatus } from '../windows/assistant'
import { takeFilesFor, toAttachments } from '../files/attach'
import { loadContent } from '../files/content'
import { readXlsx } from '../files/office'
import { sharedFiles, type SharedFile } from '../files/store'
import { sharePointedFile } from '../files/share'
import { makeIntent, openIntent, type MakeIntent } from './intent'
import { stemOf } from './place'
import { DOC_FORMATS, docContentSchema, PLACES, type DocFormat } from './schema'
import { parseCsv, rowsToCsv, sniffSeparator } from './text'
import { sheetsToXlsx } from './xlsx'
import { createDocument, lastMade, realWriteDeps, type CreateResult } from './write'
import { shareMade } from './tool'
import { readFile } from 'fs/promises'

/** "Open it" means the file made this recently. */
export const OPEN_WINDOW_MS = 15 * 60_000
const MAX_TOKENS = 12_000

const answer = (text: string, spoken?: string): ModelResponse => ({
  mode: 'answer',
  text,
  ...(spoken ? { spoken } : {})
})

export const makeReplySchema = z.object({
  format: z.enum(DOC_FORMATS),
  name: z.string(),
  title: docContentSchema.shape.title,
  blocks: docContentSchema.shape.blocks,
  place: z.enum(PLACES),
  summary: z.string().describe('One short spoken sentence on what the file holds.')
})

const SYSTEM = `You write the content of a file the user asked Lumen to make (Word, Excel, CSV, Markdown, text, HTML or PDF). Reply with JSON only:
- format: the format the user asked for (the hint says which when known).
- name: a short file name without extension ("Trip budget").
- title: the document title ("" for spreadsheets and CSV).
- blocks: the whole content in order. kind heading (text, level 1-3), paragraph (text, **bold** allowed), bullets / numbered (items), table (rows: the first row is the header, every row the same number of cells). Unused fields: "" / 0 / [].
- place: default, documents, desktop, downloads or next_to_source (next to the file it was made from), as the hint says.
- summary: one short sentence for the user on what the file holds.
Write the real, complete content: no placeholders, no "...", no notes about yourself. For spreadsheets and CSV put the data in one table per sheet, numbers as plain digits ("1234.5", no currency signs or thousands separators in number columns). When reformatting a shared file keep all of its facts unless the user asked to shorten it; "one page" means at most about 400 words.
${UNTRUSTED_CONTENT_RULE}`

export interface MakeDeps {
  write: typeof createDocument
  writeDeps: typeof realWriteDeps
}

/** The format when the user did not say: tables stay tables, everything else becomes Word. */
export function defaultFormat(source: SharedFile | undefined): DocFormat {
  if (!source) return 'docx'
  if (source.kind === 'sheet' || /\.(csv|tsv)$/i.test(source.name)) return 'xlsx'
  return 'docx'
}

/** CSV ↔ Excel without a model; null when this is not such a conversion. */
export async function convertLocally(
  source: SharedFile,
  format: DocFormat
): Promise<Buffer | string | null> {
  const isCsv = /\.(csv|tsv)$/i.test(source.name)
  if (format === 'xlsx' && isCsv) {
    const text = (await readFile(source.path, 'utf8')).replace(/^\ufeff/, '')
    return sheetsToXlsx([{ name: stemOf(source.name), rows: parseCsv(text, sniffSeparator(text)) }])
  }
  if (format === 'csv' && source.kind === 'sheet') {
    const sheets = readXlsx(await readFile(source.path))
    if (!sheets.length) return null
    return '\ufeff' + rowsToCsv(sheets[0].rows)
  }
  return null
}

function pickSource(files: SharedFile[]): SharedFile | undefined {
  return files.find((f) => f.fresh) ?? files[0]
}

async function reply(r: CreateResult, summary = ''): Promise<ModelResponse> {
  if (!r.ok) return answer(r.error)
  // Shared like a drop: "attach it to an email" or "now make it shorter" can use it.
  await shareMade(r.file.path)
  const more = summary.trim() ? ` ${summary.trim()}` : ''
  return answer(
    `${r.spoken}${more}\n\nSay “open it” to open it, or “show it in Explorer”.`,
    `${r.spoken}${more}`
  )
}

/** One "make a file" request. */
export async function makeFile(
  prompt: string,
  intent: MakeIntent,
  signal: AbortSignal
): Promise<ModelResponse> {
  const shared = await sharePointedFile(prompt)
  if (shared && !shared.ok && intent.reformat && !sharedFiles().length) return answer(shared.error)
  const files = takeFilesFor(prompt)
  const source = intent.reformat || intent.convertOnly ? pickSource(files) : undefined
  if (
    intent.reformat &&
    !source &&
    /\b(?:this|that)\s+(?:file|document|doc|csv|pdf|spreadsheet|sheet)\b/i.test(prompt)
  )
    return answer('Which file? Point at it in File Explorer while you ask, or drop it on the bar.')
  const format = intent.format ?? defaultFormat(source)
  const place = intent.place ?? (source ? 'next_to_source' : 'default')
  const ctx = {
    origin: 'user-direct' as const,
    taskId: newTaskId(),
    userText: prompt,
    ...(source ? { sourcePath: source.path } : {})
  }
  const replace = intent.replace && !!source
  const name = replace && source ? stemOf(source.name) : ''

  if (intent.convertOnly && source) {
    const bytes = await convertLocally(source, format).catch(() => null)
    if (bytes !== null) {
      log('plan', `make file: ${format} converted locally`)
      const r = await createDocument(
        { format, name: name || stemOf(source.name), place, replace },
        ctx,
        await realWriteDeps(),
        bytes
      )
      return reply(r)
    }
  }

  const { llm, model, effort } = getProvider('main')
  const parts = (
    await Promise.all(
      files.map((f) => loadContent(f, { pdf: llm.id === 'anthropic' || llm.id === 'openai' }))
    )
  ).flat()
  const att = toAttachments(parts)
  const hint = [
    `format: ${format}${intent.format ? ' (the user said so)' : ' (default)'}`,
    `place: ${place}`,
    source ? `made from: ${source.id} "${source.name.replace(/"/g, '')}"` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const res = await llm.complete(
    {
      model,
      system: [{ text: SYSTEM, cacheable: true }],
      messages: [
        {
          role: 'user',
          content: `<request>${prompt}</request>\n<hint>\n${hint}\n</hint>${att.text ? `\n\n${att.text}` : ''}`
        }
      ],
      images: att.images,
      documents: att.documents,
      maxTokens: MAX_TOKENS,
      effort,
      schema: makeReplySchema,
      schemaName: 'lumen_make_file'
    },
    signal
  )
  const out = res.data ?? parseJsonAs(res.text, makeReplySchema)
  if (!out) return answer('I could not write that file. Try asking again in other words.')
  const r = await createDocument(
    {
      format: intent.format ?? out.format,
      name: name || out.name,
      title: out.title,
      blocks: out.blocks,
      place:
        intent.place ?? (source ? place : out.place === 'next_to_source' ? 'default' : out.place),
      replace
    },
    ctx,
    await realWriteDeps()
  )
  return reply(r, out.summary)
}

async function openMade(kind: 'open' | 'reveal'): Promise<ModelResponse> {
  const f = lastMade()
  if (!f) return answer('I have not made a file yet.')
  const { shell } = await import('electron')
  if (kind === 'reveal') {
    shell.showItemInFolder(f.path)
    return answer(`Showing ${f.name} in File Explorer.`)
  }
  const err = await shell.openPath(f.path)
  return err ? answer(`I could not open ${f.name}: ${err}`) : answer(`Opening ${f.name}.`)
}

/**
 * The voice / typed entry, ahead of the answer pipeline: a promise of the reply when the request
 * is about making or opening a made file, else undefined.
 */
export function interceptDocs(prompt: string): Promise<ModelResponse> | undefined {
  const open = openIntent(prompt)
  const made = lastMade()
  if (open && made && Date.now() - made.at <= OPEN_WINDOW_MS) return openMade(open)
  const intent = makeIntent(prompt, sharedFiles().length > 0)
  if (!intent) return undefined
  return (async () => {
    const scope = beginScope()
    armEscape()
    setStatus('thinking', 'Making the file')
    try {
      return await makeFile(prompt, intent, scope.signal)
    } catch (e) {
      if (isAbortError(e) || scope.cancelled) return answer('Cancelled.')
      log('fail', `make file failed: ${(e as Error).message}`)
      return answer('I could not make that file.')
    } finally {
      endScope(scope)
      disarmEscape()
    }
  })()
}
