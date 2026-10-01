import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { EvalAction } from '../../src/main/actions/safety'
import { grantedFileHandlers, grantedPath, type GrantedPorts } from '../../src/main/files/granted'

const DL = 'C:\\Users\\ana\\Downloads'
const PAPERS = 'C:\\Users\\ana\\Documents\\Papers'
const ident = (p: string): string => p
const ctx = { signal: new AbortController().signal } as Parameters<
  ReturnType<typeof grantedFileHandlers>['rename_file']
>[1]

interface Setup {
  h: ReturnType<typeof grantedFileHandlers>
  disk: Set<string>
  actions: EvalAction[]
  undo: [string, string][]
  ports: GrantedPorts
}

function setup(files: string[], over: Partial<GrantedPorts> = {}): Setup {
  const disk = new Set(files.map((f) => f.toLowerCase()))
  const dirs = new Set([DL, PAPERS].map((d) => d.toLowerCase()))
  const actions: EvalAction[] = []
  const undo: [string, string][] = []
  const ports: GrantedPorts = {
    roots: () => [DL, PAPERS],
    real: (p) => (disk.has(p.toLowerCase()) || dirs.has(p.toLowerCase()) ? p : null),
    exists: (p) => disk.has(p.toLowerCase()),
    isDir: (p) => dirs.has(p.toLowerCase()),
    check: async (path) => ({
      ok: true,
      path,
      name: path.split('\\').pop()!,
      size: 5,
      kind: 'pdf'
    }),
    load: async (f) => [{ type: 'text', text: `<file name="${f.name}">` }],
    move: async (from, to) => {
      if (disk.has(to.toLowerCase())) throw Object.assign(new Error('taken'), { code: 'EEXIST' })
      disk.delete(from.toLowerCase())
      disk.add(to.toLowerCase())
    },
    gate: async (a) => {
      actions.push(a)
      return { ok: true, reason: '', finish: () => {} }
    },
    recordMove: async (from, to) => {
      undo.push([from, to])
    },
    audit: vi.fn(),
    ...over
  }
  const h = grantedFileHandlers(
    () => ports,
    () => ({ origin: 'routine', taskId: 'background:b1' })
  )
  return { h, disk, actions, undo, ports }
}

describe('grantedPath', () => {
  it('stays inside the granted folders', () => {
    const roots = [DL]
    expect(grantedPath(join(DL, 'a.pdf'), roots, ident)).toEqual({
      ok: true,
      path: join(DL, 'a.pdf')
    })
    expect(grantedPath(join(DL, '..', 'secret.txt'), roots, ident).ok).toBe(false)
    expect(grantedPath('\\\\host\\share\\a.pdf', roots, ident).ok).toBe(false)
    expect(grantedPath('a.pdf', roots, ident).ok).toBe(false)
    expect(grantedPath(join(DL, 'a.pdf:x'), roots, ident).ok).toBe(false)
    const link = (p: string): string => (p.endsWith('link.pdf') ? 'C:\\Windows\\win.ini' : p)
    expect(grantedPath(join(DL, 'link.pdf'), roots, link).ok).toBe(false)
  })
})

describe('rename_file', () => {
  it('renames in place, keeps the extension and records undo', async () => {
    const src = join(DL, 'scan0001.pdf')
    const { h, disk, actions, undo } = setup([src])
    const out = await h.rename_file({ path: src, newName: 'Attention Is All You Need' }, ctx)
    expect(out.isError).toBeUndefined()
    expect(disk.has(join(DL, 'Attention Is All You Need.pdf').toLowerCase())).toBe(true)
    expect(actions[0].type).toBe('move_file')
    expect(undo).toEqual([[src, join(DL, 'Attention Is All You Need.pdf')]])
  })

  it('never overwrites: picks a free name', async () => {
    const src = join(DL, 'a.pdf')
    const { h, disk } = setup([src, join(DL, 'Report.pdf')])
    await h.rename_file({ path: src, newName: 'Report.pdf' }, ctx)
    expect(disk.has(join(DL, 'Report (2).pdf').toLowerCase())).toBe(true)
    expect(disk.has(join(DL, 'Report.pdf').toLowerCase())).toBe(true)
  })

  it('refuses another extension, paths outside the grants and a denied gate', async () => {
    const src = join(DL, 'a.pdf')
    const { h } = setup([src])
    expect((await h.rename_file({ path: src, newName: 'a.exe' }, ctx)).isError).toBe(true)
    expect((await h.rename_file({ path: 'C:\\Windows\\a.pdf', newName: 'b' }, ctx)).isError).toBe(
      true
    )
    const denied = setup([src], {
      gate: async () => ({ ok: false, reason: 'nobody there', finish: () => {} })
    })
    const out = await denied.h.rename_file({ path: src, newName: 'b' }, ctx)
    expect(out.isError).toBe(true)
    expect(denied.disk.has(src.toLowerCase())).toBe(true)
  })
})

describe('move_file', () => {
  it('moves between granted folders without replacing', async () => {
    const src = join(DL, 'paper.pdf')
    const { h, disk } = setup([src, join(PAPERS, 'paper.pdf')])
    const out = await h.move_file({ path: src, toFolder: PAPERS }, ctx)
    expect(out.isError).toBeUndefined()
    expect(disk.has(join(PAPERS, 'paper (2).pdf').toLowerCase())).toBe(true)
    expect(
      (await h.move_file({ path: join(PAPERS, 'paper.pdf'), toFolder: 'C:\\Temp' }, ctx)).isError
    ).toBe(true)
  })
})

describe('read_document', () => {
  it('reads granted files and audits the read', async () => {
    const src = join(DL, 'paper.pdf')
    const { h, ports } = setup([src])
    const out = await h.read_document({ path: src }, ctx)
    expect(out.content[0]).toMatchObject({ text: '<file name="paper.pdf">' })
    expect(ports.audit).toHaveBeenCalledWith({ type: 'read_document', path: src }, 'ok')
    expect((await h.read_document({ path: 'C:\\x.pdf' }, ctx)).isError).toBe(true)
  })
})

describe('undo records only after the move (review M4)', () => {
  it('a move that fails leaves no undo record', async () => {
    const src = join(DL, 'a.pdf')
    const { h, undo, disk } = setup([src], {
      move: async () => {
        throw Object.assign(new Error('other drive'), { code: 'EXDEV' })
      }
    })
    const out = await h.rename_file({ path: src, newName: 'b' }, ctx)
    expect(out.isError).toBe(true)
    expect(undo).toEqual([])
    expect(disk.has(src.toLowerCase())).toBe(true)
  })

  it('a name taken meanwhile is retried with the next free one', async () => {
    const src = join(DL, 'a.pdf')
    const s = setup([src])
    let first = true
    s.ports.move = async (from, to) => {
      // Another task takes "b.pdf" between the free-name check and the move.
      if (first) {
        first = false
        s.disk.add(to.toLowerCase())
        throw Object.assign(new Error('taken'), { code: 'EEXIST' })
      }
      s.disk.delete(from.toLowerCase())
      s.disk.add(to.toLowerCase())
    }
    const out = await s.h.rename_file({ path: src, newName: 'b' }, ctx)
    expect(out.isError).toBeUndefined()
    expect(s.undo).toEqual([[src, join(DL, 'b (2).pdf')]])
  })
})
