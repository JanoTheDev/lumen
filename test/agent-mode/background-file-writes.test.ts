import { describe, expect, it, vi } from 'vitest'
import type { SkillManifest } from '@shared/types'
import {
  fileWriteGuarded,
  fileWriteNeedsConfirm,
  fileWriteText
} from '../../src/main/agent-mode/background/run'
import type { ToolHandler } from '../../src/main/agent-mode/runner'

const manifest = (over: Partial<SkillManifest> = {}): SkillManifest =>
  ({
    name: 'tidy',
    description: 'tidies files',
    version: '1.0.0',
    apps: [],
    triggers: [],
    params: {},
    permissions: { input: false, network: [], profile: false, risky: false, connectors: [] },
    context: 'background',
    ...over
  }) as unknown as SkillManifest

const ctx = { signal: new AbortController().signal } as Parameters<ToolHandler>[1]

describe('file changes in skill runs (review L1)', () => {
  it('an untrusted community skill without a tools list asks before moving files', () => {
    const m = manifest()
    expect(
      fileWriteNeedsConfirm(true, { name: 'tidy', manifest: m, trust: 'community-untrusted' })
    ).toBe(true)
    expect(fileWriteNeedsConfirm(true, null)).toBe(true)
    expect(fileWriteNeedsConfirm(true, { name: 'tidy', manifest: m, trust: 'mine' })).toBe(false)
    expect(fileWriteNeedsConfirm(false, null)).toBe(false)
  })

  it('a "Deny" answer stops the move and is audited', async () => {
    const move = vi.fn<ToolHandler>(async () => ({ content: [{ type: 'text', text: 'Moved' }] }))
    const read = vi.fn<ToolHandler>(async () => ({ content: [] }))
    const audit = vi.fn()
    const ask = vi.fn(async () => false)
    const h = fileWriteGuarded(
      { move_file: move, read_document: read },
      async () => ({ confirm: true, skill: 'Skill “tidy”' }),
      ask,
      audit
    )
    const out = await h.move_file(
      { path: 'C:\\Users\\ana\\Downloads\\a.pdf', toFolder: 'C:\\X' },
      ctx
    )
    expect(out.isError).toBe(true)
    expect(move).not.toHaveBeenCalled()
    expect(ask).toHaveBeenCalledWith('Skill “tidy”: move a.pdf to C:\\X. Allow it?')
    expect(audit).toHaveBeenCalledWith({ type: 'move_file' }, 'denied', 'the user said no')
    await h.read_document({ path: 'x' }, ctx)
    expect(read).toHaveBeenCalled()
  })

  it('a trusted skill moves without a question', async () => {
    const move = vi.fn<ToolHandler>(async () => ({ content: [] }))
    const ask = vi.fn(async () => true)
    const h = fileWriteGuarded(
      { move_file: move },
      async () => ({ confirm: false, skill: '' }),
      ask,
      vi.fn()
    )
    await h.move_file({}, ctx)
    expect(ask).not.toHaveBeenCalled()
    expect(move).toHaveBeenCalled()
    expect(fileWriteText('rename_file', { path: 'D:\\a\\b.txt', newName: 'c' })).toBe(
      'rename b.txt to c'
    )
  })
})
