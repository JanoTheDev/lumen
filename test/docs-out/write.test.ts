import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import {
  folderFor,
  freePath,
  safeStem,
  writeProblem,
  writeRoots,
  type Folders
} from '../../src/main/docs-out/place'
import { createDocument, lastMade, type WriteDeps } from '../../src/main/docs-out/write'
import type { EvalAction } from '../../src/main/actions/safety'

const HOME = 'C:\\Users\\ana'
const F: Folders = {
  documents: join(HOME, 'Documents'),
  desktop: join(HOME, 'Desktop'),
  downloads: join(HOME, 'Downloads'),
  granted: ['D:\\Work']
}
const ident = (p: string): string => p

describe('names', () => {
  it('makes a safe stem', () => {
    expect(safeStem('Trip budget', '.xlsx')).toBe('Trip budget')
    expect(safeStem('..\\..\\Windows\\evil.docx', '.docx')).toBe('Windows evil')
    expect(safeStem('a:b*c?"d<e>|f', '.md')).toBe('a b c d e f')
    expect(safeStem('CON', '.txt')).toBe('Lumen document')
    expect(safeStem('nul.tar', '.txt')).toBe('Lumen document')
    expect(safeStem('  ...  ', '.txt')).toBe('Lumen document')
    expect(safeStem('report.', '.txt')).toBe('report')
    expect(safeStem('x'.repeat(200), '.txt')).toHaveLength(80)
  })

  it('never reuses an existing name', () => {
    const taken = new Set([join('C:\\d', 'a.docx'), join('C:\\d', 'a (2).docx')])
    expect(freePath('C:\\d', 'a', '.docx', (p) => taken.has(p))).toBe(join('C:\\d', 'a (3).docx'))
    expect(freePath('C:\\d', 'b', '.docx', (p) => taken.has(p))).toBe(join('C:\\d', 'b.docx'))
    expect(freePath('C:\\d', 'a', '.docx', () => true)).toBeNull()
  })
})

describe('folders and path safety', () => {
  it('puts files in Documents\\Lumen by default and next to the source when asked', () => {
    expect(folderFor('default', F)).toEqual({ ok: true, dir: join(F.documents, 'Lumen') })
    expect(folderFor('desktop', F)).toEqual({ ok: true, dir: F.desktop })
    expect(folderFor('next_to_source', F, 'E:\\data\\x.csv')).toEqual({ ok: true, dir: 'E:\\data' })
    expect(folderFor('next_to_source', F).ok).toBe(false)
  })

  it('refuses network, device, stream and outside paths', () => {
    const roots = writeRoots(F)
    expect(writeProblem('\\\\server\\share\\a.docx', roots, ident)).toMatch(/Network/)
    expect(writeProblem('//server/share/a.docx', roots, ident)).toMatch(/Network/)
    expect(writeProblem('\\\\?\\C:\\Users\\ana\\Documents\\a.docx', roots, ident)).toMatch(
      /Network/
    )
    expect(writeProblem('\\\\.\\PhysicalDrive0', roots, ident)).toMatch(/Network/)
    expect(writeProblem(join(F.documents, 'a.txt:hidden'), roots, ident)).toMatch(/plain file/)
    expect(writeProblem('C:\\Windows\\System32\\a.txt', roots, ident)).toMatch(/only save/)
    expect(writeProblem(join(F.documents, '..', '..', 'x.txt'), roots, ident)).toMatch(/only save/)
    expect(writeProblem(join(F.documents, 'Lumen', 'a.docx'), roots, ident)).toBeNull()
    expect(writeProblem('D:\\Work\\sub\\a.docx', roots, ident)).toBeNull()
    expect(writeProblem('E:\\data\\a.docx', roots, ident)).toMatch(/only save/)
    expect(writeProblem('E:\\data\\a.docx', writeRoots(F, 'E:\\data\\x.csv'), ident)).toBeNull()
  })

  it('refuses a folder that links out of the roots', () => {
    const real = (p: string): string | null =>
      p.toLowerCase().startsWith(join(F.desktop, 'link').toLowerCase()) ? 'C:\\Windows' : p
    expect(writeProblem(join(F.desktop, 'link', 'a.docx'), writeRoots(F), real)).toMatch(
      /links outside/
    )
  })
})

function fakeDeps(over: Partial<WriteDeps> = {}): WriteDeps & {
  files: Map<string, Buffer | string>
  actions: EvalAction[]
} {
  const files = new Map<string, Buffer | string>()
  const actions: EvalAction[] = []
  return {
    files,
    actions,
    folders: () => F,
    exists: (p) => files.has(p),
    real: ident,
    mkdir: async () => {},
    write: async (p, data, replace) => {
      if (!replace && files.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files.set(p, data)
    },
    pdf: async () => Buffer.from('%PDF-1.7'),
    gate: async (a) => {
      actions.push(a)
      return { ok: true, reason: '', finish: () => {} }
    },
    keepForUndo: () => true,
    now: () => 1000,
    ...over
  }
}

const content = {
  title: 'Packing list',
  blocks: [{ kind: 'bullets', text: '', level: 0, items: ['Tent'], rows: [] }]
}

describe('createDocument', () => {
  it('saves a new file in Documents\\Lumen through the gate', async () => {
    const deps = fakeDeps()
    const r = await createDocument(
      { format: 'md', name: 'Packing', place: 'default', replace: false, ...content },
      { origin: 'agent', taskId: 't1' },
      deps
    )
    expect(r.ok).toBe(true)
    const path = join(F.documents, 'Lumen', 'Packing.md')
    expect(deps.files.get(path)).toBe('# Packing list\n\n- Tent\n')
    expect(deps.actions[0]).toMatchObject({ type: 'write_file', action: 'default' })
    expect(r.ok && r.spoken).toBe('Saved Packing.md in Documents\\Lumen.')
    expect(lastMade()?.path).toBe(path)
  })

  it('picks a new name instead of overwriting', async () => {
    const deps = fakeDeps()
    const existing = join(F.desktop, 'Packing.md')
    deps.files.set(existing, 'old')
    const r = await createDocument(
      { format: 'md', name: 'Packing', place: 'desktop', replace: false, ...content },
      { origin: 'user-direct', taskId: 't2' },
      deps
    )
    expect(r.ok && r.file.path).toBe(join(F.desktop, 'Packing (2).md'))
    expect(deps.files.get(existing)).toBe('old')
    expect(deps.actions[0].action).toBe('elsewhere')
  })

  it('replaces only through a replace confirm and keeps an undo copy', async () => {
    const keep = vi.fn(() => true)
    const deps = fakeDeps({ keepForUndo: keep })
    const existing = join(F.desktop, 'Packing.md')
    deps.files.set(existing, 'old')
    const r = await createDocument(
      { format: 'md', name: 'Packing', place: 'desktop', replace: true, ...content },
      { origin: 'user-direct', taskId: 't3' },
      deps
    )
    expect(r.ok).toBe(true)
    expect(deps.actions[0].action).toBe('replace')
    expect(keep).toHaveBeenCalledWith(existing, 'changed', 't3')
    expect(deps.files.get(existing)).not.toBe('old')
  })

  it('writes nothing when the gate says no', async () => {
    const deps = fakeDeps({
      gate: async () => ({ ok: false, reason: 'not confirmed', finish: () => {} })
    })
    const r = await createDocument(
      { format: 'docx', name: 'x', place: 'default', replace: false, ...content },
      { origin: 'agent', taskId: 't4' },
      deps
    )
    expect(r).toMatchObject({ ok: false, denied: true })
    expect(deps.files.size).toBe(0)
  })

  it('takes ready bytes (a local conversion) and refuses empty content', async () => {
    const deps = fakeDeps()
    const r = await createDocument(
      { format: 'csv', name: 'data', place: 'next_to_source', replace: false },
      { origin: 'user-direct', taskId: 't5', sourcePath: 'E:\\data\\data.xlsx' },
      deps,
      'a,b\r\n'
    )
    expect(r.ok && r.file.path).toBe('E:\\data\\data.csv')
    const empty = await createDocument(
      { format: 'csv', name: 'data', place: 'default', replace: false },
      { origin: 'user-direct', taskId: 't6' },
      deps
    )
    expect(empty.ok).toBe(false)
  })

  it('reports a file that appeared meanwhile instead of overwriting it', async () => {
    const deps = fakeDeps({
      write: async () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
    })
    const r = await createDocument(
      { format: 'txt', name: 'x', place: 'default', replace: false, ...content },
      { origin: 'user-direct', taskId: 't7' },
      deps
    )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/just appeared/)
  })
})
