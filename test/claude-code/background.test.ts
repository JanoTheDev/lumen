import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSessionView } from '@shared/claude-code'
import type { AuditEntry } from '../../src/main/audit/log'
import { BackgroundManager, type RunOutcome } from '../../src/main/agent-mode/background/manager'
import {
  barView,
  permissionAnswer,
  pushLine,
  runClaudeTurn,
  type SessionPort
} from '../../src/main/claude-code/background'
import { PermissionBridge, type BridgeDeps } from '../../src/main/claude-code/bridge'
import { decisionPrompt, profileForDecision } from '../../src/main/claude-code/autopilot'
import { withLumenHooks } from '../../src/main/claude-code/hooks-config'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function view(over: Partial<ClaudeSessionView> = {}): ClaudeSessionView {
  return {
    id: 'cc_t1234',
    project: 'C:\\p',
    projectName: 'p',
    title: 'p: fix',
    phase: 'thinking',
    lastLine: 'Thinking',
    costUsd: 1,
    turns: 3,
    startedAt: 1,
    lastActive: 1,
    autopilot: 'careful',
    autoAnswers: [],
    commands: [],
    ...over
  }
}

/** A session the test drives by hand. */
function fakePort(start: ClaudeSessionView): {
  port: SessionPort
  set(patch: Partial<ClaudeSessionView>): void
  answers: string[]
  perms: string[]
  interrupts: number
} {
  let v: ClaudeSessionView | null = start
  const fns = new Set<(v: ClaudeSessionView) => void>()
  const h = {
    answers: [] as string[],
    perms: [] as string[],
    interrupts: 0,
    set(patch: Partial<ClaudeSessionView>) {
      v = { ...v!, ...patch }
      for (const f of [...fns]) f(v)
    },
    port: {
      view: () => v,
      onChange: (fn: (v: ClaudeSessionView) => void) => {
        fns.add(fn)
        return () => fns.delete(fn)
      },
      answer: (t: string) => h.answers.push(t),
      permission: (a: string, id?: string) => h.perms.push(`${a}:${id}`),
      interrupt: () => h.interrupts++
    } as SessionPort
  }
  return h
}

function manager(): BackgroundManager {
  let n = 0
  return new BackgroundManager({
    max: () => 1,
    run: () => new Promise<RunOutcome>(() => {}),
    emit: () => {},
    now: () => Date.now(),
    newId: () => `bg_c${n++}`
  })
}

describe('runClaudeTurn', () => {
  it('follows the session: progress, cost share, question, then done when idle', async () => {
    const m = manager()
    const h = fakePort(view())
    const t = m.start({
      prompt: 'p: fix',
      origin: 'voice',
      claude: { id: 'cc_t1234', projectName: 'p', phase: 'thinking' },
      run: (ctl) => runClaudeTurn(ctl, h.port)
    })
    h.set({ phase: 'running-tool', lastLine: 'Running npm test', costUsd: 1.25, turns: 4 })
    expect(m.get(t.id)!.progress).toContain('Running npm test')
    expect(m.get(t.id)!.counters).toMatchObject({ costUsd: 0.25, modelCalls: 1 })
    expect(m.get(t.id)!.claude?.phase).toBe('running-tool')
    // Idle for a moment while autopilot decides: the same task stays open.
    h.set({ phase: 'idle' })
    h.set({ phase: 'thinking', lastLine: 'Lumen is choosing an answer' })
    await flush()
    expect(m.get(t.id)!.phase).toBe('running')
    h.set({
      phase: 'waiting-answer',
      pending: { kind: 'question', text: 'Tabs or spaces?', choices: ['Tabs', 'Spaces'] }
    })
    expect(m.get(t.id)!.phase).toBe('asking')
    expect(m.get(t.id)!.question).toEqual({ text: 'Tabs or spaces?', choices: ['Tabs', 'Spaces'] })
    expect(m.answer(t.id, 'Spaces')).toBe(true)
    await flush()
    expect(h.answers).toEqual(['Spaces'])
    h.set({ phase: 'thinking', pending: undefined })
    h.set({ phase: 'idle', lastAnswer: 'Switched to spaces.' })
    await flush()
    expect(m.get(t.id)).toMatchObject({ phase: 'done', result: { summary: 'Switched to spaces.' } })
  })

  it('relays a permission with Allow / Always allow / Deny and clears it when answered elsewhere', async () => {
    const m = manager()
    const h = fakePort(view())
    const t = m.start({ prompt: 'x', origin: 'voice', run: (ctl) => runClaudeTurn(ctl, h.port) })
    h.set({
      phase: 'waiting-permission',
      pending: { kind: 'permission', text: 'Claude wants to run npm i', permId: 'perm_1' }
    })
    expect(m.get(t.id)!.question?.choices).toEqual(['Allow', 'Always allow', 'Deny'])
    m.answer(t.id, 'Always allow')
    await flush()
    expect(h.perms).toEqual(['always:perm_1'])
    h.set({
      phase: 'waiting-permission',
      pending: { kind: 'permission', text: 'Claude wants to push', permId: 'perm_2' }
    })
    expect(m.get(t.id)!.phase).toBe('asking')
    // Answered by voice / on the bar: the row goes back to running.
    h.set({ phase: 'running-tool', pending: undefined })
    expect(m.get(t.id)).toMatchObject({ phase: 'running', question: undefined })
  })

  it('interrupts the session on Stop and on the cost cap', async () => {
    const m = manager()
    const h = fakePort(view())
    const t = m.start({ prompt: 'x', origin: 'voice', run: (ctl) => runClaudeTurn(ctl, h.port) })
    m.cancel(t.id)
    await flush()
    expect(h.interrupts).toBe(1)
    expect(m.get(t.id)!.phase).toBe('cancelled')

    const h2 = fakePort(view())
    const t2 = m.start({
      prompt: 'y',
      origin: 'voice',
      run: (ctl) => runClaudeTurn(ctl, h2.port, { maxCostUsd: 0.5, maxWallMs: 0 })
    })
    h2.set({ costUsd: 1.2 })
    h2.set({ costUsd: 1.6 })
    await flush()
    expect(h2.interrupts).toBe(1)
    expect(m.get(t2.id)!.phase).toBe('failed')
    expect(m.get(t2.id)!.result?.summary).toContain('$0.50 cap')
  })

  it('without a cap Claude’s cost never stops the task', async () => {
    const m = manager()
    const h = fakePort(view())
    const t = m.start({ prompt: 'x', origin: 'voice', run: (ctl) => runClaudeTurn(ctl, h.port) })
    h.set({ costUsd: 500 })
    await flush()
    expect(m.get(t.id)!.phase).toBe('running')
    expect(h.interrupts).toBe(0)
  })
})

describe('bar view helpers', () => {
  it('keeps the last distinct lines and builds the view', () => {
    let lines: string[] = []
    for (const l of ['a', 'a', 'b', '', 'c', 'd', 'e', 'f', 'g']) lines = pushLine(lines, l)
    expect(lines).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
    const b = barView(view({ phase: 'running-tool', lastLine: 'Running npm test' }), lines)
    expect(b.status).toContain('Claude in p')
    expect(b.lines).toHaveLength(6)
  })

  it('reads spoken permission answers', () => {
    expect(permissionAnswer('Always allow')).toBe('always')
    expect(permissionAnswer('allow')).toBe('once')
    expect(permissionAnswer('Deny')).toBe('deny')
    expect(permissionAnswer('whatever')).toBe('deny')
  })
})

describe('observed sessions (global PermissionRequest, T38)', () => {
  function bridge(over: Partial<BridgeDeps> = {}): { b: PermissionBridge; deps: BridgeDeps } {
    const audits: AuditEntry[] = []
    const deps: BridgeDeps = {
      session: () => null,
      ask: vi.fn(() => new Promise<boolean>(() => {})),
      dismiss: vi.fn(),
      present: () => true,
      onPending: vi.fn(),
      audit: (e) => audits.push(e),
      now: () => 1000,
      ...over
    }
    return { b: new PermissionBridge(deps), deps }
  }
  const payload = {
    session_id: 'abc-123',
    cwd: 'C:\\work\\proj',
    tool_name: 'Bash',
    tool_input: { command: 'npm install left-pad' }
  }
  const signal = (): AbortSignal => new AbortController().signal

  it('hands back to Claude’s own prompt when nobody answers in time', async () => {
    vi.useFakeTimers()
    try {
      const { b, deps } = bridge()
      const p = b.handleObserved(payload, signal(), 30_000)
      await Promise.resolve()
      expect(b.list()[0]).toMatchObject({ sessionKey: 'g:abc-123', projectName: 'proj' })
      vi.advanceTimersByTime(30_000)
      expect(await p).toEqual({})
      expect(deps.dismiss).toHaveBeenCalled()
      expect(b.list()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a voice answer on, and stays out of it when the user is away', async () => {
    const { b } = bridge()
    const p = b.handleObserved(payload, signal(), 30_000)
    await Promise.resolve()
    expect(b.answer('once')).toBe(true)
    expect((await p).hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    })
    const away = bridge({ present: () => false })
    expect(await away.b.handleObserved(payload, signal(), 30_000)).toEqual({})
    expect(away.deps.ask).not.toHaveBeenCalled()
  })

  it('adds the PermissionRequest hook only when opted in', () => {
    const base = 'http://127.0.0.1:5000'
    const off = withLumenHooks({}, base, 'a'.repeat(64)) as { hooks: Record<string, unknown> }
    expect(off.hooks.PermissionRequest).toBeUndefined()
    const on = withLumenHooks({}, base, 'a'.repeat(64), { permissions: true, waitS: 30 }) as {
      hooks: Record<string, { hooks: { url: string; timeout: number }[] }[]>
    }
    expect(on.hooks.PermissionRequest[0].hooks[0]).toMatchObject({
      url: `${base}/lumen-hook/g/PermissionRequest`,
      timeout: 45
    })
  })
})

describe('memory profile in the autopilot decision (T36)', () => {
  it('feeds redacted profile facts and drops facts that are only a secret', () => {
    const key = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-')
    const facts = profileForDecision([
      { text: 'Prefers small commits with short messages' },
      { text: `my key is ${key}` },
      { text: key },
      { text: 'Work mail jane@example.com, prefers TypeScript' }
    ])
    expect(facts[0]).toBe('Prefers small commits with short messages')
    expect(facts.join(' ')).not.toContain(key)
    expect(facts.join(' ')).not.toContain('jane@example.com')
    expect(facts).toHaveLength(3)
    const p = decisionPrompt({
      question: { question: 'Commit now?', options: [] },
      recent: [],
      profile: facts
    })
    expect(p).toContain('<profile>\n- Prefers small commits')
  })
})
