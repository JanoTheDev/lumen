// The create_file tool for agent mode and background tasks: the same writer, the same checks,
// the origin and the unattended rule of the task that calls it. A made file joins the shared
// files of the conversation, so attach_file and later requests can use its id.
import type { ToolContent, ToolDef } from '../ai/providers/types'
import type { GateCtx } from '../actions/policy'
import { getFile, registerFile } from '../files/store'
import type { ToolHandler, ToolOutcome } from '../agent-mode/runner'
import { createFileInput, DOC_FORMATS, PLACES, type CreateFileInput } from './schema'
import { createDocument, realWriteDeps, type WriteDeps } from './write'

export const CREATE_FILE_TOOL: ToolDef = {
  name: 'create_file',
  description:
    'Saves a new document the user asked for: Word (docx), Excel (xlsx), CSV, Markdown, text, HTML or PDF, from headings, paragraphs, lists and tables. Default folder Documents\\Lumen; never overwrites unless replace is true and the user agrees. Put the full content in blocks (no placeholders). For a file made from a shared file, pass its id as sourceFileId. Returns the saved name and the new file id (for attach_file); tell the user they can say "open it" or "show it in Explorer".',
  schema: createFileInput
}

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A lenient read of the input (providers without strict tools): blocks are normalized later. */
export function readCreateInput(raw: Record<string, unknown>): CreateFileInput | null {
  const format = DOC_FORMATS.find((f) => f === raw.format)
  if (!format) return null
  const place = PLACES.find((p) => p === raw.place) ?? 'default'
  return {
    format,
    name: str(raw.name),
    title: str(raw.title),
    blocks: (Array.isArray(raw.blocks) ? raw.blocks : []) as CreateFileInput['blocks'],
    place,
    sourceFileId: str(raw.sourceFileId),
    replace: raw.replace === true
  }
}

/** A create_file handler for one task (`gate`: its origin, task id and user words). */
export function createFileHandler(
  gate: () => GateCtx,
  deps?: () => Promise<WriteDeps>,
  share: (path: string) => Promise<string | null> = shareMade
): ToolHandler {
  return async (raw): Promise<ToolOutcome> => {
    const input = readCreateInput(raw)
    if (!input)
      return {
        content: text(`E_INVALID: format must be one of ${DOC_FORMATS.join(', ')}.`),
        isError: true
      }
    const source = input.sourceFileId ? getFile(input.sourceFileId) : undefined
    if (input.sourceFileId && !source)
      return { content: text('E_DENIED: no shared file with that id.'), isError: true }
    const r = await createDocument(
      input,
      { ...gate(), ...(source ? { sourcePath: source.path } : {}) },
      await (deps ?? realWriteDeps)()
    )
    if (!r.ok) return { content: text(r.denied ? `E_DENIED: ${r.error}` : r.error), isError: true }
    const id = await share(r.file.path)
    return { content: text(`${r.spoken}${id ? ` File id: ${id}.` : ''}`) }
  }
}

/** Adds a made file to the conversation's shared files; its id, or null. */
export async function shareMade(path: string): Promise<string | null> {
  const r = await registerFile(path).catch(() => null)
  if (!r?.ok) return null
  // Not "fresh": only a request that names it ("the spreadsheet", its name) reads it again.
  r.file.fresh = false
  return r.file.id
}
