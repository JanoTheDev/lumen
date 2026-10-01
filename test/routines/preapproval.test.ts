import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { BgPorts } from '../../src/main/agent-mode/background/handlers'
import { BackgroundManager } from '../../src/main/agent-mode/background/manager'
import { runBackground } from '../../src/main/agent-mode/background/run'
import {
  allowsForeground,
  matchesShape,
  preApproved,
  routineGuard,
  setPresence,
  validShape
} from '../../src/main/routines/preapproval'
import { preapprovalQuestion, wantsFor } from '../../src/main/routines/draft'

describe('pre-approval', () => {
  it('matches tool and argument patterns', () => {
    const shape = { tool: 'mcp__mail__send', args: { to: 'me@example.com', subject: 'Report*' } }
    expect(
      matchesShape(shape, 'mcp__mail__send', { to: 'ME@example.com', subject: 'Report 3' })
    ).toBe(true)
    expect(
      matchesShape(shape, 'mcp__mail__send', { to: 'boss@example.com', subject: 'Report' })
    ).toBe(false)
    expect(matchesShape(shape, 'mcp__mail__send', { to: 'me@example.com' })).toBe(false)
    expect(matchesShape({ tool: 'mcp__files__*' }, 'mcp__files__read', {})).toBe(true)
    expect(preApproved([], 'request_foreground', {})).toBe(false)
    expect(allowsForeground([{ tool: 'request_foreground' }])).toBe(true)
    expect(allowsForeground([{ tool: 'request_foreground', args: { reason: 'x' } }])).toBe(false)
  })

  it('pattern text is literal except *', () => {
    expect(matchesShape({ tool: 'x', args: { a: 'a.b' } }, 'x', { a: 'aXb' })).toBe(false)
    expect(matchesShape({ tool: 'x', args: { a: '(.*)' } }, 'x', { a: 'anything' })).toBe(false)
  })

  it('validates shapes', () => {
    expect(validShape({ tool: 'request_foreground' })).toBe(true)
    expect(validShape({ tool: 'mcp__*' })).toBe(true)
    expect(validShape({ tool: 'bad tool' })).toBe(false)
    expect(validShape({ tool: 'x', args: { a: 1 } })).toBe(false)
  })

  it('the guard skips high-risk calls unless pre-approved', () => {
    const g = routineGuard(
      [{ tool: 'mcp__mail__send', args: { to: 'me@example.com' } }],
      () => true
    )
    expect(g('fetch_url', { url: 'https://example.com' })).toBeNull()
    expect(g('request_foreground', { reason: 'x', steps: [] })).toMatch(/pre-approved/)
    expect(g('mcp__mail__send', { to: 'me@example.com' })).toBeNull()
    expect(g('mcp__mail__send', { to: 'boss@example.com' })).toMatch(/pre-approved/)
  })
})

describe('presence gating', () => {
  it('pre-approved mouse use only while the user is at the PC', () => {
    let present = true
    const g = routineGuard([{ tool: 'request_foreground' }], () => present)
    expect(g('request_foreground', {})).toBeNull()
    present = false
    expect(g('request_foreground', {})).toMatch(/away/)
    // Connector and read-only tools do not depend on presence.
    expect(routineGuard([{ tool: 'mcp__*' }], () => false)('mcp__mail__send', {})).toBeNull()
    expect(g('fetch_url', {})).toBeNull()
  })

  it('the default presence comes from setPresence (wired to idle time + quiet mode)', () => {
    setPresence(() => false)
    expect(routineGuard([{ tool: 'request_foreground' }])('request_foreground', {})).toMatch(/away/)
    setPresence(() => true)
    expect(routineGuard([{ tool: 'request_foreground' }])('request_foreground', {})).toBeNull()
  })

  it('drafts offer pre-approval only for risky work', () => {
    expect(wantsFor({ kind: 'remind', say: 'Stretch.' })).toEqual({
      foreground: false,
      connectors: false
    })
    expect(wantsFor({ kind: 'task', prompt: 'summarize the news on example.com' })).toEqual({
      foreground: false,
      connectors: false
    })
    expect(wantsFor({ kind: 'task', prompt: 'rename it by its title' }).foreground).toBe(true)
    expect(wantsFor({ kind: 'task', prompt: 'send me an email with the totals' }).connectors).toBe(
      true
    )
    expect(preapprovalQuestion({ foreground: false, connectors: false })).toBeNull()
    expect(preapprovalQuestion({ foreground: true, connectors: false })).toMatch(
      /mouse and keyboard.*only uses the mouse while you are at the PC/
    )
  })
})

describe('automation runs on the background runner', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const reply = (...calls: ToolCall[]): ToolTurnResult => ({
    message: { role: 'assistant', text: '', calls },
    usage,
    model: 'fake',
    stopReason: calls.length ? 'tool_use' : 'end_turn'
  })

  async function runWith(guard: ReturnType<typeof routineGuard>): Promise<string[]> {
    const log: string[] = []
    const ports: BgPorts = {
      taskId: 'bg_r',
      child: false,
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: 'text/plain',
        text: 'x',
        truncated: false
      }),
      readFile: () => ({ ok: false, error: 'E_DENIED' }),
      memorySearch: () => '',
      memoryWrite: () => 'ok',
      notify: () => {},
      ask: async () => '',
      requestForeground: async () => {
        log.push('foreground')
        return { status: 'done', summary: 'clicked' }
      },
      spawn: async () => ({ id: 'bg_c', ok: true }),
      childCount: () => 0,
      progress: () => {},
      audit: (a, r) => log.push(`audit ${String(a.type)} ${r}`)
    } as BgPorts
    const script = [
      reply({
        id: 'c1',
        name: 'request_foreground',
        input: { reason: 'open the app', steps: ['click A'] }
      }),
      reply({ id: 'c2', name: 'finish', input: { summary: 'Skipped the screen part.' } })
    ]
    let i = 0
    let n = 0
    const m = new BackgroundManager({
      max: () => 3,
      run: (ctl) =>
        runBackground(ctl, {
          caps: { maxModelCalls: 10, maxCostUsd: 1, maxWallMs: 60_000 },
          ports,
          turn: async () => script[Math.min(i++, script.length - 1)],
          costOf: () => 0,
          now: () => Date.now(),
          guard
        }),
      emit: () => {},
      now: () => Date.now(),
      newId: () => `bg_rt${n++}`
    })
    const t = m.start({ prompt: 'automation work', origin: 'routine', routineId: 'au_abcd1' })
    const end = await m.wait(t.id)
    expect(end.phase).toBe('done')
    return log
  }

  it('request_foreground without pre-approval never reaches the port', async () => {
    const log = await runWith(routineGuard([], () => true))
    expect(log).not.toContain('foreground')
    expect(log).toContain('audit request_foreground denied')
  })

  it('pre-approved but the user is away: still never reaches the port', async () => {
    const log = await runWith(routineGuard([{ tool: 'request_foreground' }], () => false))
    expect(log).not.toContain('foreground')
    expect(log).toContain('audit request_foreground denied')
  })

  it('pre-approved and present: it may ask for the foreground', async () => {
    const log = await runWith(routineGuard([{ tool: 'request_foreground' }], () => true))
    expect(log).toContain('foreground')
  })
})
