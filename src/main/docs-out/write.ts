// create_file: content → format → a new file. The folder and name are checked (place.ts),
// every write goes through the policy gate (a new file in Documents\Lumen is low; elsewhere is
// medium for agents; replacing an existing file always asks) and is audited there, and undo
// can remove what was made ("undo that"). The file is written exclusively ('wx'), so a file
// that appeared meanwhile is never overwritten without the confirm.
import { existsSync, realpathSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { GateCtx } from '../actions/policy'
import type { EvalAction } from '../actions/safety'
import { log } from '../logger'
import {
  defaultFolder,
  folderFor,
  freePath,
  safeStem,
  writeProblem,
  writeRoots,
  type Folders
} from './place'
import { EXT, normalizeDoc, type CreateFileInput, type DocContent, type DocFormat } from './schema'
import { toCsv, toHtml, toMarkdown, toText } from './text'
import { toDocx } from './docx'
import { toXlsx } from './xlsx'

export interface MadeFile {
  path: string
  name: string
  format: DocFormat
  at: number
}

export type CreateResult =
  | { ok: true; file: MadeFile; spoken: string }
  | { ok: false; error: string; denied?: boolean }

export interface WriteDeps {
  folders(): Folders
  exists(p: string): boolean
  real(p: string): string | null
  mkdir(dir: string): Promise<void>
  /** Exclusive unless `replace`; rejects with EEXIST when the file appeared meanwhile. */
  write(path: string, data: Buffer | string, replace: boolean): Promise<void>
  pdf(html: string): Promise<Buffer>
  gate(
    action: EvalAction,
    ctx: GateCtx
  ): Promise<{ ok: boolean; reason: string; finish(r: 'ok' | 'error'): void }>
  /** Undo record (keepFileForUndo); false = no copy of a replaced file could be kept. */
  keepForUndo(path: string, verb: 'created' | 'changed', taskId: string): boolean
  now(): number
}

export interface CreateCtx extends GateCtx {
  /** The real path of the file this was made from (next_to_source). */
  sourcePath?: string
}

/** The bytes of a document in a format. */
export async function render(
  format: DocFormat,
  doc: DocContent,
  pdf: (html: string) => Promise<Buffer>
): Promise<Buffer | string> {
  switch (format) {
    case 'docx':
      return toDocx(doc)
    case 'xlsx':
      return toXlsx(doc)
    case 'csv':
      return toCsv(doc)
    case 'md':
      return toMarkdown(doc)
    case 'txt':
      return toText(doc)
    case 'html':
      return toHtml(doc)
    case 'pdf':
      return pdf(toHtml(doc))
  }
}

/** "Documents\Lumen", "Desktop", or the folder's own name, for spoken replies. */
export function folderLabel(dir: string, f: Folders): string {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  if (same(dir, defaultFolder(f))) return 'Documents\\Lumen'
  if (same(dir, f.documents)) return 'Documents'
  if (same(dir, f.desktop)) return 'your desktop'
  if (same(dir, f.downloads)) return 'Downloads'
  return `the ${basename(dir)} folder`
}

let last: MadeFile | null = null

/** The file made last (for "open it" / "show it in Explorer"). */
export function lastMade(): MadeFile | null {
  return last
}

export function forgetLastMade(): void {
  last = null
}

/**
 * Makes the file. `bytes`: content already in the format (a conversion that needs no model,
 * e.g. CSV → Excel); else the blocks are rendered.
 */
export async function createDocument(
  input: Pick<CreateFileInput, 'format' | 'name' | 'place' | 'replace'> & {
    title?: string
    blocks?: unknown
  },
  ctx: CreateCtx,
  deps: WriteDeps,
  bytes?: Buffer | string
): Promise<CreateResult> {
  const format = input.format
  const ext = EXT[format]
  const doc = normalizeDoc({ title: input.title ?? '', blocks: input.blocks ?? [] })
  if (bytes === undefined && !doc.blocks.length && !doc.title)
    return { ok: false, error: 'There is nothing to put in the file.' }
  const folders = deps.folders()
  const where = folderFor(input.place, folders, ctx.sourcePath)
  if (!where.ok) return where
  const stem = safeStem(input.name || doc.title, ext)
  const wanted = join(where.dir, stem + ext)
  const replacing = input.replace && deps.exists(wanted)
  const target = replacing ? wanted : freePath(where.dir, stem, ext, deps.exists)
  if (!target) return { ok: false, error: 'There are too many files with that name already.' }
  const problem = writeProblem(target, writeRoots(folders, ctx.sourcePath), deps.real)
  if (problem) return { ok: false, error: problem, denied: true }

  const name = basename(target)
  const label = folderLabel(dirname(target), folders)
  const isDefault = dirname(target).toLowerCase() === defaultFolder(folders).toLowerCase()
  const g = await deps.gate(
    {
      type: 'write_file',
      action: replacing ? 'replace' : isDefault ? 'default' : 'elsewhere',
      description: `${name} in ${label}`
    },
    ctx
  )
  if (!g.ok) return { ok: false, error: `I did not save it: ${g.reason}`, denied: true }
  try {
    const data = bytes ?? (await render(format, doc, deps.pdf))
    await deps.mkdir(dirname(target))
    if (!deps.keepForUndo(target, replacing ? 'changed' : 'created', ctx.taskId) && replacing) {
      g.finish('error')
      return { ok: false, error: 'I could not keep a copy of the old file, so I left it alone.' }
    }
    await deps.write(target, data, replacing)
    g.finish('ok')
  } catch (e) {
    g.finish('error')
    const code = (e as NodeJS.ErrnoException).code
    log('fail', `create_file failed: ${code ?? (e as Error).message}`)
    return {
      ok: false,
      error:
        code === 'EEXIST'
          ? 'A file with that name just appeared. Ask again and I will pick a new name.'
          : code === 'EACCES' || code === 'EPERM'
            ? `I am not allowed to save in ${label}.`
            : 'Saving the file failed.'
    }
  }
  const file: MadeFile = { path: target, name, format, at: deps.now() }
  last = file
  log('done', `create_file: ${format} saved (${label})`)
  return {
    ok: true,
    file,
    spoken: `Saved ${name} in ${label}${replacing ? ', replacing the old one' : ''}.`
  }
}

/** The real dependencies (Electron paths, the policy gate, undo). */
export async function realWriteDeps(): Promise<WriteDeps> {
  const { app } = await import('electron')
  const { gate } = await import('../actions/policy')
  const { keepFileForUndo } = await import('../undo')
  const { htmlToPdf } = await import('./pdf')
  const { loadConfig } = await import('../config')
  const { expandRoot } = await import('../agent-mode/background/files')
  return {
    folders: () => ({
      documents: app.getPath('documents'),
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads'),
      granted: loadConfig()
        .agent.background.readFolders.map(expandRoot)
        .filter((r): r is string => !!r)
    }),
    exists: (p) => existsSync(p),
    real: (p) => {
      try {
        return realpathSync.native(p)
      } catch {
        return null
      }
    },
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true })
    },
    write: (p, data, replace) => writeFile(p, data, { flag: replace ? 'w' : 'wx' }),
    pdf: htmlToPdf,
    gate: async (action, ctx) => {
      const g = await gate(action, ctx)
      return { ok: g.ok, reason: g.decision.reason, finish: (r) => g.finish(r) }
    },
    keepForUndo: keepFileForUndo,
    now: () => Date.now()
  }
}
