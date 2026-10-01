import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { BgPorts } from '../../src/main/agent-mode/background/handlers'
import {
  BackgroundManager,
  type RunOutcome,
  type TaskControl
} from '../../src/main/agent-mode/background/manager'
import { runBackground, type BgRunEnv } from '../../src/main/agent-mode/background/run'

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
let seq = 0
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id: `c${++seq}`,
  name,
  input
})
const reply = (...calls: ToolCall[]): ToolTurnResult => ({
  message: { role: 'assistant', text: '', calls },
  usage,
  model: 'fake',
  stopReason: calls.length ? 'tool_use' : 'end_turn'
})

function ports(over: Partial<BgPorts> = {}): BgPorts & { log: string[] } {
  const log: string[] = []
  return {
    log,
    taskId: 'bg_test',
    child: false,
    fetch: async (url) => {
      log.push(`fetch ${url}`)
      return { url, status: 200, contentType: 'text/html', text: 'Price: 10', truncated: false }
    },
    readFile: () => ({ ok: false, error: 'E_DENIED: no folders are granted to background tasks.' }),
    memorySearch: () => 'Nothing saved.',
    memoryWrite: () => 'ok',
    notify: (t) => log.push(`notify ${t}`),
    ask: async () => 'Friday',
    requestForeground: async () => ({ status: 'cancelled' }),
    spawn: async (i) => ({ id: 'bg_child', ok: true, summary: `did ${i.prompt}` }),
    childCount: () => 0,
    progress: (l) => log.push(`progress ${l}`),
    audit: (a, r) => log.push(`audit ${String(a.type)} ${r}`),
    ...over
  }
}

function env(
  script: ToolTurnResult[],
  p: BgPorts,
  over: Partial<BgRunEnv> = {}
): { e: BgRunEnv; turns: unknown[] } {
  let i = 0
  const turns: unknown[] = []
  const e: BgRunEnv = {
    caps: { maxModelCalls: 30, maxCostUsd: 0.25, maxWallMs: 900_000 },
    ports: p,
    turn: async (req) => {
      turns.push(req)
      return script[Math.min(i++, script.length - 1)]
    },
    costOf: () => 0.001,
    now: () => Date.now(),
    ...over
  }
  return { e, turns }
}

/** A manager whose runs use runBackground with this env. */
function managed(make: (ctl: TaskControl) => BgRunEnv): BackgroundManager {
  let n = 0
  return new BackgroundManager({
    max: () => 3,
    run: (ctl): Promise<RunOutcome> => runBackground(ctl, make(ctl)),
    emit: () => {},
    now: () => Date.now(),
    newId: () => `bg_run${n++}`
  })
}

describe('runBackground', () => {
  it('fetches, finishes and returns the report; tools are the background set', async () => {
    const p = ports()
    const { e, turns } = env(
      [
        reply(call('fetch_url', { url: 'https://shop.example/lamp' })),
        reply(
          call('finish', {
            summary: 'The lamp costs 10.',
            report: '- 10 (https://shop.example/lamp)'
          })
        )
      ],
      p
    )
    const m = managed(() => e)
    const t = m.start({ prompt: 'check the lamp price', origin: 'voice' })
    const end = await m.wait(t.id)
    expect(end.phase).toBe('done')
    expect(end.result).toMatchObject({ summary: 'The lamp costs 10.' })
    expect(end.counters.modelCalls).toBe(2)
    expect(p.log).toContain('fetch https://shop.example/lamp')
    expect(p.log).toContain('audit fetch_url ok')
    const req = turns[0] as {
      tools: { name: string }[]
      messages: { content: { text: string }[] }[]
    }
    const names = req.tools.map((x) => x.name)
    expect(names).toEqual(
      expect.arrayContaining(['ask_user', 'finish', 'fetch_url', 'read_file', 'spawn_task'])
    )
    expect(names).not.toContain('act')
    expect(names).not.toContain('observe')
    expect(req.messages[0].content[0].text).toContain('<task>check the lamp price</task>')
    // Second turn carries the page as observed data.
    const second = turns[1] as {
      messages: { content: { type: string; content?: { text: string }[] }[] }[]
    }
    expect(JSON.stringify(second.messages.at(-1))).toContain(
      '<observed source=\\"web https://shop.example/lamp\\">'
    )
  })

  it('denied file reads come back as E_DENIED tool errors', async () => {
    const p = ports()
    const { e, turns } = env(
      [
        reply(call('read_file', { path: 'C:\\Windows\\win.ini' })),
        reply(call('finish', { summary: 'Could not.' }))
      ],
      p
    )
    const m = managed(() => e)
    await m.wait(m.start({ prompt: 'read my ini file', origin: 'voice' }).id)
    expect(JSON.stringify(turns[1])).toContain('E_DENIED')
    expect(p.log).toContain('audit read_file denied')
  })

  it('spawn_task with wait fans out in parallel', async () => {
    let active = 0
    let peak = 0
    const p = ports({
      spawn: async (i) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return { id: `bg_${i.prompt.replace(/\W/g, '')}`, ok: true, summary: `found ${i.prompt}` }
      }
    })
    const { e, turns } = env(
      [
        reply(
          call('spawn_task', { prompt: 'a', wait: true }),
          call('spawn_task', { prompt: 'b', wait: true }),
          call('spawn_task', { prompt: 'c', wait: true })
        ),
        reply(call('finish', { summary: 'Compared.' }))
      ],
      p
    )
    const m = managed(() => e)
    const end = await m.wait(m.start({ prompt: 'compare a b c', origin: 'voice' }).id)
    expect(end.phase).toBe('done')
    expect(peak).toBe(3)
    const results = JSON.stringify(turns[1])
    expect(results).toContain('found a')
    expect(results).toContain('found c')
  })

  it('children cannot spawn and get no spawn_task tool', async () => {
    const p = ports({ child: true })
    const { e, turns } = env(
      [
        reply(call('spawn_task', { prompt: 'x', wait: true })),
        reply(call('finish', { summary: 'ok' }))
      ],
      p
    )
    const m = managed(() => e)
    const child = m.start({
      prompt: 'child task',
      origin: 'agent',
      parentId: 'bg_parent',
      immediate: true
    })
    await m.wait(child.id)
    const req = turns[0] as { tools: { name: string }[] }
    expect(req.tools.map((x) => x.name)).not.toContain('spawn_task')
    expect(JSON.stringify(turns[1])).toMatch(/Unknown tool|E_DENIED/)
  })

  it('a cap pauses with a queued question; "Stop" ends the task', async () => {
    const p = ports()
    const { e } = env([reply(call('memory_search', { query: 'x' }))], p, {
      caps: { maxModelCalls: 2, maxCostUsd: 1, maxWallMs: 900_000 }
    })
    const m = managed(() => e)
    const t = m.start({ prompt: 'loop forever please', origin: 'voice' })
    for (let i = 0; i < 50 && m.get(t.id)!.phase !== 'asking'; i++)
      await new Promise((r) => setTimeout(r, 1))
    expect(m.get(t.id)!.question?.text).toContain('2 model calls')
    m.answer(t.id, 'Stop')
    const end = await m.wait(t.id)
    expect(end.phase).toBe('failed')
    expect(end.result?.summary).toContain('limit')
  })

  it('"Keep going" at a cap raises it by its starting size', async () => {
    const p = ports()
    let turnsDone = 0
    const { e } = env([], p, {
      caps: { maxModelCalls: 2, maxCostUsd: 1, maxWallMs: 900_000 },
      turn: async () =>
        ++turnsDone < 3
          ? reply(call('memory_search', { query: 'x' }))
          : reply(call('finish', { summary: 'ok' }))
    })
    const m = managed(() => e)
    const t = m.start({ prompt: 'needs three calls', origin: 'voice' })
    for (let i = 0; i < 50 && m.get(t.id)!.phase !== 'asking'; i++)
      await new Promise((r) => setTimeout(r, 1))
    m.answer(t.id, 'Keep going')
    expect((await m.wait(t.id)).phase).toBe('done')
  })

  it('notify is capped per task', async () => {
    const p = ports()
    const n = (t: string): ToolCall => call('notify', { text: t })
    const { e } = env(
      [reply(n('1'), n('2'), n('3'), n('4')), reply(call('finish', { summary: 'ok' }))],
      p
    )
    const m = managed(() => e)
    await m.wait(m.start({ prompt: 'tell me things', origin: 'voice' }).id)
    expect(p.log.filter((l) => l.startsWith('notify'))).toHaveLength(3)
  })
})
