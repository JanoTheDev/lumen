import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CODE_DEFAULTS,
  type ClaudeProject,
  type ClaudeSessionView
} from '@shared/claude-code'
import type { AuditEntry } from '../../src/main/audit/log'
import type { AutopilotDecision } from '../../src/main/claude-code/autopilot'
import { ClaudeCopilot, statusLine, type CopilotDeps } from '../../src/main/claude-code/copilot'
import type { SavedSession } from '../../src/main/claude-code/store'
import { fakeSpawn } from './fake'

let dir: string
let project: ClaudeProject
let copilot: ClaudeCopilot | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-cc-'))
  const p = join(dir, 'proj')
  mkdirSync(join(p, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(p, '.claude', 'commands', 'ship-it.md'), '---\ndescription: Ship\n---\nGo')
  project = { path: p, name: 'proj', source: 'user' }
})

afterEach(async () => {
  if (copilot) {
    const live = copilot.list()
    copilot.shutdown()
    await new Promise((r) => setTimeout(r, live.length ? 400 : 0))
  }
  copilot = null
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface Harness {
  c: ClaudeCopilot
  notices: { text: string; kind: string }[]
  audits: AuditEntry[]
  saved: SavedSession[]
  decide: ReturnType<typeof vi.fn>
}

function harness(decision: Partial<AutopilotDecision> | Error = {}): Harness {
  const notices: Harness['notices'] = []
  const audits: AuditEntry[] = []
  const saved: SavedSession[] = []
  const decide = vi.fn(async () => {
    if (decision instanceof Error) throw decision
    return {
      answer: 'spaces',
      confidence: 0.95,
      reason: 'because CLAUDE.md says so',
      stakes: 'low',
      ...decision
    }
  })
  let n = 0
  const deps: CopilotDeps = {
    settings: () => ({ ...CLAUDE_CODE_DEFAULTS }),
    cliPath: async () => 'claude.exe',
    projects: () => [project],
    spawn: fakeSpawn(),
    hookBase: () => 'http://127.0.0.1:1',
    writeSettings: (key) => {
      const f = join(dir, `${key}.json`)
      writeFileSync(f, '{}')
      return f
    },
    removeSettings: () => {},
    decide: decide as CopilotDeps['decide'],
    claudeMd: () => 'Use spaces.',
    notify: (text, kind) => notices.push({ text, kind }),
    audit: (e) => audits.push(e),
    saved: () => saved,
    remember: (s) => {
      const i = saved.findIndex((x) => x.sessionId === s.sessionId)
      if (i >= 0) saved[i] = s
      else saved.push(s)
    },
    changed: () => {},
    now: () => Date.now(),
    newId: () => `cc_t${++n}`,
    log: () => {}
  }
  copilot = new ClaudeCopilot(deps)
  return { c: copilot, notices, audits, saved, decide }
}

function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const v = fn()
      if (v) return resolve(v)
      if (Date.now() - t0 > ms) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('ClaudeCopilot', () => {
  it('lists no session when its command line cannot be built', async () => {
    const h = harness()
    await expect(
      h.c.open({ ...project, allowedTools: ['--permission-mode'] }, { prompt: 'x' })
    ).rejects.toThrow(/refused/)
    expect(h.c.list()).toEqual([])
    expect(h.c.focused()).toBeFalsy()
  })

  it('opens a session, runs the first prompt and announces the end', async () => {
    const h = harness()
    const v = await h.c.open(project, { prompt: 'fix it' })
    expect(v.id).toBe('cc_t1')
    await waitFor(() => h.notices.find((n) => n.kind === 'done'))
    expect(h.notices[0].text).toContain('Claude finished in proj: done: fix it')
    expect(h.saved[0]).toMatchObject({ project: project.path })
    expect(h.c.focused()?.id).toBe('cc_t1')
    // One session per project: opening again reuses it.
    expect((await h.c.open(project)).id).toBe('cc_t1')
  })

  it('answers Claude’s question on autopilot and can take it back', async () => {
    const h = harness()
    await h.c.open(project, { prompt: 'ASK' })
    await waitFor(() => h.c.focused()?.autoAnswers.length)
    const v = h.c.focused()!
    expect(v.autoAnswers[0]).toMatchObject({ answer: 'spaces' })
    expect(h.audits.some((a) => a.origin === 'claude-code' && a.decision === 'auto')).toBe(true)
    expect(h.notices.some((n) => n.text.includes('undo that answer'))).toBe(true)
    // The answer went to Claude as the next turn.
    await waitFor(() => h.c.focused()?.lastAnswer === 'done: spaces')
    expect(h.c.undoAnswer(v.id)).toBe(true)
    // The correction ends with the question again: relayed to the user this time.
    await waitFor(() => h.c.focused()?.pending?.kind === 'question')
    expect(h.c.focused()!.lastAnswer).toContain('done: Correction from the user')
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.c.undoAnswer(v.id)).toBe(false)
  })

  it('stops a turn and takes a follow-up on the same session', async () => {
    const h = harness()
    const v = await h.c.open(project, { prompt: 'SLOW' })
    await waitFor(() => h.c.get(v.id)?.phase === 'running-tool')
    expect(await h.c.interrupt(v.id)).toBe(true)
    await waitFor(() => h.c.get(v.id)?.lastLine === 'Interrupted')
    h.c.send(v.id, 'carry on')
    await waitFor(() => h.notices.find((n) => n.kind === 'done'))
    expect(h.c.get(v.id)!.lastAnswer).toBe('done: carry on')
    // The interrupted turn is not reported as a problem.
    expect(h.notices.some((n) => n.text.includes('problem'))).toBe(false)
  })

  it('feeds the memory profile into the decision', async () => {
    const h = harness()
    const deps = (h.c as unknown as { deps: CopilotDeps }).deps
    deps.profile = () => ['Prefers spaces']
    await h.c.open(project, { prompt: 'ASK' })
    await waitFor(() => h.decide.mock.calls.length)
    expect(h.decide.mock.calls[0][0]).toMatchObject({ profile: ['Prefers spaces'] })
  })

  it('relays the question when the model is unsure', async () => {
    const h = harness({ confidence: 0.3 })
    await h.c.open(project, { prompt: 'ASK' })
    const v = await waitFor(() =>
      h.c.focused()?.pending?.kind === 'question' ? h.c.focused() : undefined
    )
    expect(v!.phase).toBe('waiting-answer')
    expect(statusLine(v!)).toContain('asks: ')
    expect(h.notices.at(-1)).toMatchObject({ kind: 'needs-you' })
    expect(h.c.answerQuestion(v!.id, 'tabs')).toBe(true)
    await waitFor(() => h.c.focused()?.lastAnswer === 'done: tabs')
  })

  it('relays high-stakes questions and when autopilot is off', async () => {
    const h = harness({ stakes: 'high' })
    await h.c.open(project, { prompt: 'ASK' })
    await waitFor(() => h.c.focused()?.pending?.kind === 'question')
    const id = h.c.focused()!.id
    h.c.setAutopilot('off', id)
    expect(h.c.get(id)!.autopilot).toBe('off')
  })

  it('relays when the decision call fails', async () => {
    const h = harness(new Error('no key'))
    await h.c.open(project, { prompt: 'ASK' })
    await waitFor(() => h.c.focused()?.pending?.kind === 'question')
  })

  it('maps "run <command>" to the project’s slash command', async () => {
    const h = harness()
    const v = await h.c.open(project)
    h.c.send(v.id, 'run ship it')
    await waitFor(() => h.c.focused()?.lastAnswer === 'done: /ship-it')
  })

  it('fails to open without the CLI', async () => {
    const h = harness()
    const c = new ClaudeCopilot({
      ...(h.c as unknown as { deps: CopilotDeps }).deps,
      cliPath: async () => null
    })
    await expect(c.open(project)).rejects.toThrow(/not installed/)
  })
})

describe('statusLine', () => {
  const base: ClaudeSessionView = {
    id: 'cc_x1234',
    project: 'C:\\p',
    projectName: 'p',
    title: 'p',
    phase: 'running-tool',
    lastLine: 'Running npm test',
    costUsd: 0.1234,
    turns: 1,
    startedAt: 0,
    lastActive: 0,
    autopilot: 'careful',
    autoAnswers: [],
    commands: []
  }
  it('says what Claude does', () => {
    expect(statusLine(null)).toContain('No Claude session')
    expect(statusLine(base)).toBe('Claude in p: Running npm test. (so far $0.12)')
    expect(
      statusLine({ ...base, pending: { kind: 'permission', text: 'x', command: 'git push' } })
    ).toContain('waiting for your OK: git push')
  })
})
