import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeSessionView } from '@shared/claude-code'
import { ClaudeSession, type TurnEnd } from '../../src/main/claude-code/session'
import { NdjsonParser } from '../../src/main/claude-code/ndjson'
import { describeTool, readEvent } from '../../src/main/claude-code/events'
import { fakeSpawn } from './fake'

let dir: string
let argsFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-cc-'))
  argsFile = join(dir, 'args.ndjson')
})
const open: ClaudeSession[] = []

afterEach(async () => {
  // The fake runs in the temp dir: wait for it to exit before removing it.
  for (const s of open.splice(0)) {
    if (!s.alive) continue
    const gone = new Promise((resolve) => s.once('exit', resolve))
    s.stop()
    await gone
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function newSession(
  over: Partial<ConstructorParameters<typeof ClaudeSession>[0]> = {}
): ClaudeSession {
  const s = new ClaudeSession(
    {
      id: 'cc_test1',
      project: dir,
      projectName: 'proj',
      cliPath: 'claude.exe',
      autopilot: 'careful',
      args: { model: 'haiku' },
      env: { FAKE_ARGS_FILE: argsFile },
      ...over
    },
    { spawn: fakeSpawn(), now: () => Date.now() }
  )
  open.push(s)
  return s
}

function nextTurn(s: ClaudeSession): Promise<TurnEnd> {
  return new Promise((resolve) => s.once('turn', resolve))
}

function until(s: ClaudeSession, pred: (v: ClaudeSessionView) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (pred(s.view)) return resolve()
    const on = (v: ClaudeSessionView): void => {
      if (pred(v)) {
        s.off('change', on)
        resolve()
      }
    }
    s.on('change', on)
  })
}

function spawnedArgs(): string[][] {
  if (!existsSync(argsFile)) return []
  return readFileSync(argsFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { args: string[] }).args)
}

describe('NdjsonParser', () => {
  it('joins split chunks and reports junk lines', () => {
    const got: unknown[] = []
    const junk: string[] = []
    const p = new NdjsonParser(
      (v) => got.push(v),
      (l) => junk.push(l)
    )
    p.push('{"a":1}\n{"b"')
    p.push(':2}\nnot json\n[1]\n')
    p.push('{"c":3}')
    p.end()
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    expect(junk).toEqual(['not json', '[1]'])
  })
})

describe('readEvent', () => {
  it('reads init, tool use and result', () => {
    expect(
      readEvent({ type: 'system', subtype: 'init', session_id: 's1', slash_commands: ['x'] }).patch
    ).toMatchObject({ sessionId: 's1', commands: ['x'], phase: 'thinking' })
    const tool = readEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }
    })
    expect(tool.patch).toEqual({ phase: 'running-tool', lastLine: 'Running npm test' })
    const r = readEvent({
      type: 'result',
      subtype: 'success',
      result: 'All good',
      total_cost_usd: 0.5
    })
    expect(r.turnEnded).toEqual({ text: 'All good', isError: false, costUsd: 0.5 })
    expect(r.patch.phase).toBe('idle')
  })

  it('describes tools briefly', () => {
    expect(describeTool('Edit', { file_path: 'C:\\p\\src\\a.ts' })).toBe('Editing a.ts')
    expect(describeTool('Mystery', {})).toBe('Using Mystery')
  })
})

describe('ClaudeSession with a fake claude', () => {
  it('runs two turns on one process, sums the cost and keeps the session id', async () => {
    const s = newSession()
    const t1 = nextTurn(s)
    s.send('hello')
    expect((await t1).text).toBe('done: hello')
    expect(s.view.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(s.view.commands).toContain('code-review')
    const t2 = nextTurn(s)
    s.send('again')
    await t2
    expect(s.view.turns).toBe(2)
    expect(s.view.costUsd).toBeCloseTo(0.02)
    expect(s.view.phase).toBe('idle')
    expect(spawnedArgs()).toHaveLength(1)
    const args = spawnedArgs()[0]
    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json']))
    expect(args.join(' ')).toContain('--permission-mode manual')
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions/)
    s.stop()
  })

  it('interrupts a turn with a control request', async () => {
    const s = newSession()
    s.send('SLOW')
    await until(s, (v) => v.phase === 'running-tool')
    const end = nextTurn(s)
    expect(await s.interrupt()).toBe(true)
    const t = await end
    expect(t.interrupted).toBe(true)
    expect(s.view.lastLine).toBe('Interrupted')
    expect(s.alive).toBe(true)
    s.stop()
  })

  it('kills a CLI that ignores the interrupt and resumes it on the next turn', async () => {
    const s = newSession()
    s.send('IGNORE_INTERRUPT')
    await until(s, (v) => v.phase === 'running-tool')
    const id = s.view.sessionId
    expect(await s.interrupt()).toBe(false)
    await until(s, () => !s.alive)
    const t = nextTurn(s)
    s.send('after')
    expect((await t).text).toBe('done: after')
    const runs = spawnedArgs()
    expect(runs).toHaveLength(2)
    expect(runs[1]).toEqual(expect.arrayContaining(['--resume', id!]))
    expect(s.view.sessionId).toBe(id)
    s.stop()
  }, 15_000)

  it('reports a crash with the stderr line', async () => {
    const s = newSession()
    s.send('CRASH')
    await until(s, (v) => v.phase === 'failed')
    expect(s.view.error).toContain('boom')
  })

  it('resumes a given session id on first spawn', async () => {
    const s = newSession({ resume: '11111111-2222-3333-4444-555555555555' })
    const t = nextTurn(s)
    s.send('hi')
    await t
    expect(spawnedArgs()[0]).toEqual(
      expect.arrayContaining(['--resume', '11111111-2222-3333-4444-555555555555'])
    )
    s.stop()
  })
})
