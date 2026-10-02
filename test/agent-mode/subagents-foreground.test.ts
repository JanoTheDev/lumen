import { describe, expect, it, vi } from 'vitest'
import type { ToolCtx, ToolHandler } from '../../src/main/agent-mode/runner'

vi.mock('electron', () => ({ app: { getPath: () => '.' } }))
vi.mock('../../src/main/audit/log', () => ({ writeAudit: vi.fn() }))
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({ agent: { background: { readFolders: [] } } })
}))
const auditTask = vi.hoisted(() => vi.fn((task: unknown) => ({ task })))
vi.mock('../../src/main/agent-mode/background', () => ({
  backgroundAuditEntry: auditTask,
  readUnder: () => ({ ok: false, error: 'E_DENIED: no folders are granted.' })
}))

const { foregroundSubagentTools, READER_READ_FILE } =
  await import('../../src/main/agent-mode/subagents/foreground')
const { TOOLS } = await import('../../src/main/agent-mode/tools')
const { withUsageScope } = await import('../../src/main/usage/scope')

const ctx = { signal: new AbortController().signal } as ToolCtx
const textOf = (o: { content: { type: string; text?: string }[] }): string =>
  o.content.map((c) => c.text ?? '').join('\n')

describe('foreground reader tools', () => {
  it('a reader can still read the files the user dropped (review L4)', async () => {
    const dropped: ToolHandler = async (i) => ({
      content: [{ type: 'text', text: `dropped ${String(i.fileId)}` }]
    })
    const t = foregroundSubagentTools({
      taskId: 't1',
      userText: 'sum up my file',
      defs: [TOOLS.read_file],
      handlers: { read_file: dropped },
      observe: () => {},
      observedText: () => ''
    })
    expect(t.defs.filter((d) => d.name === 'read_file')).toEqual([READER_READ_FILE])
    expect(textOf(await t.handlers.read_file({ fileId: 'f_1', path: '' }, ctx))).toBe('dropped f_1')
    const denied = await t.handlers.read_file({ fileId: '', path: 'C:\\x.txt' }, ctx)
    expect(denied.isError).toBe(true)
  })

  it('without dropped files the reader keeps the granted-folder read_file', () => {
    const t = foregroundSubagentTools({
      taskId: 't2',
      userText: 'x',
      defs: [],
      handlers: {},
      observe: () => {},
      observedText: () => ''
    })
    expect(t.defs.map((d) => d.name)).toContain('read_file')
    expect(t.defs.find((d) => d.name === 'read_file')).not.toBe(READER_READ_FILE)
  })

  it('a buddy run helper read is audited as the buddy', async () => {
    const t = withUsageScope({ origin: 'subagent', buddyId: 'inbox-buddy' }, () =>
      foregroundSubagentTools({
        taskId: 't3',
        userText: 'x',
        defs: [],
        handlers: {},
        observe: () => {},
        observedText: () => ''
      })
    )
    await t.handlers.read_file({ path: 'C:\\x.txt' }, ctx)
    expect(auditTask).toHaveBeenCalled()
    expect(auditTask.mock.calls.at(-1)?.[0]).toMatchObject({
      origin: 'buddy',
      buddyId: 'inbox-buddy'
    })
  })
})
