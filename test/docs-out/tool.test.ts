import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { createFileHandler, readCreateInput } from '../../src/main/docs-out/tool'
import type { WriteDeps } from '../../src/main/docs-out/write'
import { TOOLS, FOREGROUND_TOOLS } from '../../src/main/agent-mode/tools'

const F = { documents: 'C:\\D', desktop: 'C:\\Desk', downloads: 'C:\\Dl', granted: [] }

function deps(files: Map<string, unknown>, gateOrigins: string[]): WriteDeps {
  return {
    folders: () => F,
    exists: (p) => files.has(p),
    real: (p) => p,
    mkdir: async () => {},
    write: async (p, d) => void files.set(p, d),
    pdf: async () => Buffer.from(''),
    gate: async (_a, ctx) => {
      gateOrigins.push(ctx.origin)
      return { ok: true, reason: '', finish: () => {} }
    },
    prepareUndo: () => ({ commit: () => {}, discard: () => {} }),
    now: () => 1
  }
}

const ctx = { signal: new AbortController().signal } as Parameters<
  ReturnType<typeof createFileHandler>
>[1]

describe('create_file tool', () => {
  it('is offered to foreground agent mode with attach_file', () => {
    expect(FOREGROUND_TOOLS).toEqual(expect.arrayContaining(['create_file', 'attach_file']))
    expect(TOOLS.create_file.name).toBe('create_file')
  })

  it('reads loose input and fills in defaults', () => {
    expect(readCreateInput({ format: 'xlsx', blocks: 'x', place: 'nowhere' })).toEqual({
      format: 'xlsx',
      name: '',
      title: '',
      blocks: [],
      place: 'default',
      sourceFileId: '',
      replace: false
    })
    expect(readCreateInput({ format: 'exe' })).toBeNull()
  })

  it('saves through the gate with the task origin and returns the shared id', async () => {
    const files = new Map<string, unknown>()
    const origins: string[] = []
    const share = vi.fn(async () => 'f_made1')
    const h = createFileHandler(
      () => ({ origin: 'agent', taskId: 't1' }),
      async () => deps(files, origins),
      share
    )
    const out = await h(
      {
        format: 'csv',
        name: 'Prices',
        title: '',
        blocks: [{ kind: 'table', text: '', level: 0, items: [], rows: [['a', 'b']] }],
        place: 'default',
        sourceFileId: '',
        replace: false
      },
      ctx
    )
    expect(out.isError).toBeUndefined()
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('File id: f_made1.') })
    expect(files.has(join('C:\\D', 'Lumen', 'Prices.csv'))).toBe(true)
    expect(origins).toEqual(['agent'])
  })

  it('refuses an unknown source file id', async () => {
    const h = createFileHandler(
      () => ({ origin: 'agent', taskId: 't1' }),
      async () => deps(new Map(), [])
    )
    const out = await h({ format: 'md', sourceFileId: 'f_nope1', blocks: [] }, ctx)
    expect(out.isError).toBe(true)
  })
})
