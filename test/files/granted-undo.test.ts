import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../../src/main/config', () => ({ loadConfig: () => ({ helpers: { undo: true } }) }))
vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => null }))
vi.mock('../../src/main/query/context', () => ({ currentContext: () => null }))

import { grantedFileHandlers, moveNoReplace, type GrantedPorts } from '../../src/main/files/granted'
import { installUndo, recordFileMove, undoLast, undoStack } from '../../src/main/undo'
import { tempDir } from '../helpers/fixtures'

const ctx = { signal: new AbortController().signal } as Parameters<
  ReturnType<typeof grantedFileHandlers>['move_file']
>[1]
const run = async (): Promise<{ executed: number; blocked: boolean; cancelled: boolean }> => ({
  executed: 0,
  blocked: false,
  cancelled: false
})

let tmp: { dir: string; cleanup(): void }
let root: string

function realPorts(): GrantedPorts {
  return {
    roots: () => [root],
    real: (p) => {
      try {
        return realpathSync.native(p)
      } catch {
        return null
      }
    },
    exists: (p) => existsSync(p),
    isDir: (p) => existsSync(p) && !/\.[a-z]+$/i.test(p),
    check: async () => ({ ok: false, error: 'unused' }),
    load: async () => [],
    move: moveNoReplace,
    gate: async () => ({ ok: true, reason: '', finish: () => {} }),
    recordMove: async (from, to, taskId) => recordFileMove(from, to, taskId),
    audit: () => {}
  }
}

const handlers = (): ReturnType<typeof grantedFileHandlers> =>
  grantedFileHandlers(realPorts, () => ({ origin: 'agent', taskId: 'background:b1' }))

beforeEach(() => {
  tmp = tempDir('granted-undo-')
  root = realpathSync.native(tmp.dir)
  installUndo(join(root, 'trash'))
  undoStack().clear()
})
afterEach(() => tmp.cleanup())

describe('undo of rename_file / move_file (review H2)', () => {
  it('"undo that" after a move puts the file back and leaves nothing at the new place', async () => {
    const inbox = join(root, 'Inbox')
    const sorted = join(root, 'Sorted')
    mkdirSync(inbox)
    mkdirSync(sorted)
    const from = join(inbox, 'Invoice.pdf')
    writeFileSync(from, 'invoice')
    const out = await handlers().move_file({ path: from, toFolder: sorted }, ctx)
    expect(out.isError).toBeUndefined()
    expect(readdirSync(sorted)).toEqual(['Invoice.pdf'])

    expect(await undoLast(1, { run })).toContain('Undone: moved the file Invoice.pdf')
    expect(readFileSync(from, 'utf8')).toBe('invoice')
    expect(readdirSync(sorted)).toEqual([])
  })

  it('"undo that" after a rename restores the old name', async () => {
    const from = join(root, 'Invoice.pdf')
    writeFileSync(from, 'x')
    await handlers().rename_file({ path: from, newName: '2026-09 Invoice' }, ctx)
    expect(existsSync(join(root, '2026-09 Invoice.pdf'))).toBe(true)
    await undoLast(1, { run })
    expect(readFileSync(from, 'utf8')).toBe('x')
    expect(existsSync(join(root, '2026-09 Invoice.pdf'))).toBe(false)
  })

  it('undo never moves the file over one that took its old name', async () => {
    const from = join(root, 'a.pdf')
    writeFileSync(from, 'mine')
    await handlers().rename_file({ path: from, newName: 'b' }, ctx)
    writeFileSync(from, 'new one')
    expect(await undoLast(1, { run })).toContain('another file now has its old name')
    expect(readFileSync(from, 'utf8')).toBe('new one')
    expect(readFileSync(join(root, 'b.pdf'), 'utf8')).toBe('mine')
  })
})

describe('parallel moves never replace a file (review M5)', () => {
  it('two tasks moving scan.pdf into one folder keep both files', async () => {
    const a = join(root, 'A')
    const b = join(root, 'B')
    const sorted = join(root, 'Sorted')
    for (const d of [a, b, sorted]) mkdirSync(d)
    writeFileSync(join(a, 'scan.pdf'), 'from A')
    writeFileSync(join(b, 'scan.pdf'), 'from B')
    const h = handlers()
    const [r1, r2] = await Promise.all([
      h.move_file({ path: join(a, 'scan.pdf'), toFolder: sorted }, ctx),
      h.move_file({ path: join(b, 'scan.pdf'), toFolder: sorted }, ctx)
    ])
    expect(r1.isError).toBeUndefined()
    expect(r2.isError).toBeUndefined()
    expect(readdirSync(sorted).sort()).toEqual(['scan (2).pdf', 'scan.pdf'])
    const contents = readdirSync(sorted).map((n) => readFileSync(join(sorted, n), 'utf8'))
    expect(contents.sort()).toEqual(['from A', 'from B'])
  })

  it('moveNoReplace refuses a taken name and leaves both files', async () => {
    writeFileSync(join(root, 'x.txt'), '1')
    writeFileSync(join(root, 'y.txt'), '2')
    await expect(moveNoReplace(join(root, 'x.txt'), join(root, 'y.txt'))).rejects.toMatchObject({
      code: 'EEXIST'
    })
    expect(readFileSync(join(root, 'x.txt'), 'utf8')).toBe('1')
    expect(readFileSync(join(root, 'y.txt'), 'utf8')).toBe('2')
  })
})
