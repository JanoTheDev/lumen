// Agent read_file (08 T21): only ids of files dropped in this conversation.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { createHandlers, type TaskEnv } from '../../src/main/agent-mode/handlers'
import { taskTurn } from '../../src/main/agent-mode/prompts'
import { clearFiles, registerFile } from '../../src/main/files/store'

const dir = mkdtempSync(join(tmpdir(), 'lumen-readfile-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const ctx = { signal: new AbortController().signal } as never

beforeEach(() => clearFiles())

describe('read_file', () => {
  it('reads a dropped file by id and notes its text as observed', async () => {
    const p = join(dir, 'notes.md')
    writeFileSync(p, '# Plan\nShip it.')
    const r = await registerFile(p)
    if (!r.ok) throw new Error(r.error)
    const env = { observedText: '' } as TaskEnv
    const out = await createHandlers(env).read_file({ fileId: r.file.id }, ctx)
    expect(out.isError).toBeUndefined()
    expect(out.content[0]).toMatchObject({ type: 'text' })
    expect((out.content[0] as { text: string }).text).toContain('Ship it.')
    expect(env.observedText).toContain('Ship it.')
  })

  it('refuses ids that were not dropped, and paths', async () => {
    const h = createHandlers({ observedText: '' } as TaskEnv)
    for (const fileId of ['f_0000000000', 'C:\\Windows\\win.ini', '../secret.txt']) {
      const out = await h.read_file({ fileId }, ctx)
      expect(out.isError).toBe(true)
      expect((out.content[0] as { text: string }).text).toMatch(/E_DENIED/)
    }
  })

  it('lists the task files in the first turn', () => {
    const text = taskTurn(
      'summarize the pdf',
      { files: [{ id: 'f_1', name: 'r"x.pdf', kind: 'pdf' }], now: new Date(0) },
      null
    )
    expect(text).toContain('files the user dropped (read_file with the id): f_1 "rx.pdf" (pdf)')
  })
})
