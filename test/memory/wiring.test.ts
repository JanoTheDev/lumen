// Memory wired into the app: voice commands, the session lifecycle, prompt injection and the
// Settings → Memory IPC functions. Model calls use a fake provider; nothing goes to the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/ipc/settings', () => ({ broadcastConfig: vi.fn() }))
vi.mock('../../src/main/windows/registry', () => ({ broadcast: vi.fn() }))

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative, sep } from 'path'
import { createMemory, type SessionTurn } from '../../src/main/ai/memory'
import {
  endSession,
  localSummary,
  memory,
  recordTurn,
  setMemory,
  SUMMARY_SYSTEM
} from '../../src/main/ai/memory/runtime'
import { history, historyMessages } from '../../src/main/ai/history'
import { callModel } from '../../src/main/ai'
import { setProvider } from '../../src/main/ai/providers'
import type {
  ChatChunk,
  CompleteResult,
  LlmProvider,
  StructuredRequest
} from '../../src/main/ai/providers/types'
import { loadConfig, saveConfig, setConfigDir } from '../../src/main/config'
import {
  episodesFor,
  factFromSpeech,
  handleMemoryCommand,
  matchMemoryCommand,
  resetMemoryCommands,
  type MemoryCommand
} from '../../src/main/query/memory-commands'
import {
  applyFactOp,
  deleteAllMemory,
  listEpisodes,
  memoryOverview,
  reviewProposal
} from '../../src/main/ipc/memory'

let root: string
let clock: { now: Date }
const keys = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY }

function files(): string[] {
  const dir = join(root, 'memory')
  const out: string[] = []
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d)) {
      const full = join(d, e)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

function setMem(memory: Partial<ReturnType<typeof loadConfig>['memory']>): void {
  saveConfig({ memory })
}

const say = (utterance: string): string => {
  const cmd = matchMemoryCommand(utterance)
  if (!cmd) throw new Error(`not a memory command: ${utterance}`)
  const r = handleMemoryCommand(cmd, utterance)
  return r.mode === 'answer' ? (r.spoken ?? r.text) : ''
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumen-memwire-'))
  setConfigDir(join(root, 'config'))
  clock = { now: new Date('2026-10-02T15:00:00Z') }
  setMemory(
    createMemory({
      dir: join(root, 'memory'),
      settings: () => loadConfig().memory,
      now: () => clock.now,
      index: 'json-bm25',
      log: () => {}
    })
  )
  history.clear()
  resetMemoryCommands()
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  setMemory(null)
  setConfigDir(null)
  setProvider('anthropic', null)
  process.env.ANTHROPIC_API_KEY = keys.a
  process.env.OPENAI_API_KEY = keys.o
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('matching', () => {
  it('recognises the explicit commands as whole utterances', () => {
    const m = (u: string): MemoryCommand | null => matchMemoryCommand(u)
    expect(m('Remember that I use dwell clicking.')).toEqual({
      kind: 'remember',
      fact: 'Uses dwell clicking'
    })
    expect(m('hey lumen, my name is Jano')).toEqual({
      kind: 'remember',
      fact: 'Name: Jano',
      section: 'Name'
    })
    expect(m('call me jano')).toMatchObject({ fact: 'Preferred name: Jano' })
    expect(m('What do you remember about me?')).toEqual({ kind: 'recall-profile' })
    expect(m('private mode')).toEqual({ kind: 'private', on: true })
    expect(m("don't remember this")).toEqual({ kind: 'private', on: true })
    expect(m('turn off private mode')).toEqual({ kind: 'private', on: false })
    expect(m('forget everything about Blender')).toEqual({
      kind: 'forget-about',
      topic: 'blender'
    })
    expect(m("Let's continue where we left off")).toEqual({ kind: 'continue' })
    expect(m('what did we do yesterday')).toEqual({ kind: 'last-time', when: 'yesterday' })
    expect(m('what did we do last time in Blender?')).toEqual({
      kind: 'last-time',
      when: 'last-time',
      app: 'blender'
    })
  })

  it('leaves ordinary requests to the router', () => {
    for (const u of [
      'remember to email Sam at 5',
      'do you remember the file I opened?',
      'remember the guide as gmail filters',
      'what did we do',
      'my name is Jano and I use dwell clicking every day',
      'how do I make Blender remember my keymap'
    ])
      expect(matchMemoryCommand(u), u).toBeNull()
  })

  it('turns first-person speech into a profile line', () => {
    expect(factFromSpeech("I'm left-handed")).toBe('Is left-handed')
    expect(factFromSpeech('I prefer short answers')).toBe('Prefers short answers')
    expect(factFromSpeech('my Resolve project is 4K 25fps')).toBe('Resolve project is 4K 25fps')
  })
})

describe('explicit commands', () => {
  it('remember writes immediately and confirms out loud; forget that removes it', () => {
    setMem({ enabled: true })
    expect(say('remember that I use dwell clicking')).toBe("Got it, I'll remember that.")
    expect(
      memory()
        .profile.facts()
        .map((f) => [f.section, f.text])
    ).toEqual([['Access needs', 'Uses dwell clicking']])
    expect(say('my name is Jano')).toBe("Got it, I'll remember that.")
    expect(say('my name is Jan')).toBe("Got it, I've updated that.")
    expect(say('what do you remember about me')).toContain('Uses dwell clicking. Name: Jan.')
    expect(say('forget that')).toBe("Okay, I've forgotten that.")
    expect(
      memory()
        .profile.facts()
        .map((f) => f.text)
    ).toEqual(['Uses dwell clicking'])
  })

  it('never stores secrets', () => {
    setMem({ enabled: true })
    expect(say('remember that my password is hunter2')).toContain("I won't store that")
    expect(files()).toEqual([])
  })

  it('private mode writes nothing: no facts, no session file, no episode', async () => {
    setMem({ enabled: true })
    expect(say('private mode')).toContain('Private mode is on')
    expect(loadConfig().memory.privateMode).toBe(true)
    expect(say('remember that I am left-handed')).toContain('Private mode is on')
    recordTurn({ utterance: 'open my bank statement', answer: 'Opened it', app: 'Edge' })
    expect(await endSession('test')).toMatchObject({ status: 'private' })
    expect(files()).toEqual([])
  })

  it('memory disabled writes no episodes and keeps the session off disk', async () => {
    setMem({ enabled: false })
    recordTurn({ utterance: 'how do I bevel', answer: 'Ctrl+B', app: 'Blender' })
    expect(say('remember that I prefer short answers')).toContain('Memory is off')
    expect(files()).toEqual([])
    expect(await endSession('test')).toMatchObject({ status: 'disabled' })
    expect(files()).toEqual([])
  })

  it('new topic clears the conversation history', () => {
    history.add({ utterance: 'q', spoken: 'a' })
    expect(say('new topic')).toBe('Okay, new topic.')
    expect(historyMessages()).toEqual([])
  })
})

describe('session end', () => {
  const turns = (): void => {
    recordTurn({ utterance: 'how do I bevel in Blender', answer: 'Press Ctrl+B', app: 'Blender' })
    recordTurn({
      utterance: 'the export still fails',
      answer: 'Try the FFmpeg preset',
      app: 'Blender'
    })
  }

  it('saves a plain local summary when no key is set', async () => {
    setMem({ enabled: true })
    turns()
    expect(files()).toEqual(['sessions/current.jsonl'])
    const r = await endSession('idle')
    expect(r?.status).toBe('saved')
    expect(r?.episode?.title).toBe('how do I bevel in Blender')
    expect(r?.episode?.apps).toEqual(['Blender'])
    expect(files().filter((f) => f.startsWith('episodes/'))).toHaveLength(1)
    expect(memory().session.turns()).toEqual([])
  })

  it('summarizes on the fast role with the structured schema and applies sure facts in auto mode', async () => {
    setMem({ enabled: true, autoLearn: 'auto' })
    process.env.ANTHROPIC_API_KEY = 'test-key'
    let seen: StructuredRequest<unknown> | null = null
    const data = {
      episode: {
        title: 'Fixed the Blender export',
        summary: 'You beveled the cube. The export still fails at 80%.',
        apps: ['Blender'],
        outcome: 'partial',
        openThreads: ['export fails at 80%'],
        refs: []
      },
      proposals: [
        {
          layer: 'app',
          appId: 'blender',
          fact: 'Exports with FFmpeg',
          confidence: 0.9,
          sensitive: false
        },
        { layer: 'profile', fact: 'Has a tremor', confidence: 0.95, sensitive: true }
      ]
    }
    const provider: LlmProvider = {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ChatChunk> {
        throw new Error('not streamed')
      },
      complete: async <T>(req: StructuredRequest<T>): Promise<CompleteResult<T>> => {
        seen = req as StructuredRequest<unknown>
        return {
          text: JSON.stringify(data),
          data: data as T,
          model: 'claude-haiku-4-5',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      },
      warmup: async () => {}
    }
    setProvider('anthropic', provider)
    turns()
    const r = await endSession('idle')
    expect(seen!.model).toBe('claude-haiku-4-5')
    expect(seen!.schemaName).toBe('lumen_session_memory')
    expect(seen!.system[0].text).toBe(SUMMARY_SYSTEM)
    expect(seen!.messages[0].content).toContain('User: the export still fails')
    expect(r?.applied.map((p) => p.fact)).toEqual(['Exports with FFmpeg'])
    expect(r?.dropped.map((p) => p.fact)).toEqual(['Has a tremor'])
    expect(
      memory()
        .apps.facts('blender')
        .map((f) => f.text)
    ).toEqual(['Exports with FFmpeg'])
  })

  it('falls back to the local summary when the model call fails', async () => {
    setMem({ enabled: true })
    process.env.ANTHROPIC_API_KEY = 'test-key'
    setProvider('anthropic', {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ChatChunk> {
        throw new Error('offline')
      },
      complete: async () => Promise.reject(new Error('offline')),
      warmup: async () => {}
    })
    turns()
    expect((await endSession('quit'))?.status).toBe('saved')
  })

  it('local summary keeps urls as references', () => {
    const t: SessionTurn[] = [
      { ts: 1, utterance: 'open https://docs.blender.org/manual', app: 'Edge' }
    ]
    expect(localSummary(t).episode.refs).toEqual([
      { kind: 'url', value: 'https://docs.blender.org/manual' }
    ])
  })
})

describe('recall flows', () => {
  const saveEpisode = (
    iso: string,
    title: string,
    apps: string[],
    threads: string[] = []
  ): void => {
    clock.now = new Date(iso)
    memory().episodes.save({
      title,
      summary: `${title}. It went fine.`,
      apps,
      outcome: threads.length ? 'partial' : 'done',
      openThreads: threads,
      refs: threads.length ? [{ kind: 'lesson', value: 'blender-basics-03' }] : []
    })
  }

  beforeEach(() => {
    setMem({ enabled: true })
    saveEpisode('2026-09-20T10:00:00Z', 'Made a budget sheet', ['Excel'])
    saveEpisode('2026-10-01T10:00:00Z', 'Modeled a mug', ['Blender'], ['add the handle'])
    clock.now = new Date('2026-10-02T15:00:00Z')
  })

  it('what did we do yesterday / last time in an app', () => {
    expect(say('what did we do yesterday')).toBe(
      'Yesterday: Modeled a mug. Modeled a mug. It went fine. Still open: add the handle. You were on lesson blender-basics-03.'
    )
    expect(say('what did we do last time in excel')).toMatch(
      /^On September 20: Made a budget sheet/
    )
    expect(say('what did we do today')).toBe("I don't have anything saved from today.")
  })

  it('continue where we left off offers the last open thread and puts it in history', () => {
    expect(say('continue where we left off')).toContain('Still open: add the handle')
    expect(historyMessages().at(-1)?.content).toContain('Want to pick that up?')
  })

  it('episodesFor filters by day and app', () => {
    const all = memory().episodes.list()
    expect(episodesFor(all, 'last-week', undefined, clock.now).map((e) => e.title)).toEqual([
      'Modeled a mug'
    ])
    expect(episodesFor(all, 'last-time', 'the blender', clock.now)).toHaveLength(1)
  })

  it('forget everything about X removes facts and matching episodes', () => {
    memory().apps.add('blender', { text: 'Uses 4.2 keymap' })
    memory().remember('Learning Blender for 3D printing')
    expect(say('forget everything about blender')).toBe('Done. I forgot 2 things about blender.')
    expect(
      memory()
        .episodes.list()
        .map((e) => e.title)
    ).toEqual(['Made a budget sheet'])
  })
})

describe('prompt injection', () => {
  let seen: StructuredRequest<unknown>[] = []
  const reply = '{"mode":"answer","spoken":"Hi Jano."}'
  beforeEach(() => {
    seen = []
    process.env.ANTHROPIC_API_KEY = 'test-key'
    setProvider('anthropic', {
      id: 'anthropic',
      async *stream(req): AsyncIterable<ChatChunk> {
        seen.push(req)
        yield { type: 'text', text: reply }
        yield {
          type: 'done',
          result: {
            text: reply,
            model: 'claude-sonnet-5-5',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
          }
        }
      },
      complete: vi.fn(),
      warmup: async () => {}
    })
  })

  it('puts the capped memory block in the user turn of the main call only', async () => {
    setMem({ enabled: true, maxInjectTokens: 1200 })
    memory().remember('Name: Jano', { section: 'Name' })
    for (let i = 0; i < 200; i++) memory().remember(`Prefers option number ${i} in menus`)
    await callModel('hello', null, 'notes.txt - Notepad')
    const turn = seen[0].messages.at(-1)!.content
    const block = /<memory>[\s\S]*<\/memory>/.exec(turn)![0]
    expect(block).toContain('- Name: Jano')
    expect(Math.ceil(block.length / 4)).toBeLessThanOrEqual(1200)
    expect(seen[0].system.map((s) => s.text).join('')).not.toContain('<memory>')

    await callModel('step', null, 'notes.txt - Notepad', { history: false })
    expect(seen[1].messages.at(-1)!.content).not.toContain('<memory>')
  })

  it('adds nothing when memory is off', async () => {
    setMem({ enabled: false })
    await callModel('hello', null, 'Notepad')
    expect(seen[0].messages.at(-1)!.content).not.toContain('<memory>')
  })
})

describe('settings IPC functions', () => {
  it('edits facts, reviews proposals, lists episodes and deletes all with a typed confirm', async () => {
    setMem({ enabled: true, autoLearn: 'ask' })
    expect(applyFactOp({ op: 'add', layer: 'profile', text: 'Prefers short answers' })).toEqual({
      ok: true
    })
    expect(
      applyFactOp({
        op: 'update',
        layer: 'profile',
        old: 'Prefers short answers',
        text: 'Likes detailed answers'
      })
    ).toEqual({ ok: true })
    expect(
      applyFactOp({ op: 'add', layer: 'app', app: 'Blender', text: 'Uses 4.2 keymap' }).ok
    ).toBe(true)
    expect(applyFactOp({ op: 'add', layer: 'app', text: 'x' }).ok).toBe(false)
    expect(applyFactOp({ op: 'add', layer: 'profile', text: 'my password is hunter2' }).ok).toBe(
      false
    )

    memory().session.add({ utterance: 'bevel please' })
    const r = await memory().endSession(async () => ({
      episode: {
        title: 'Bevel',
        summary: 'Beveled.',
        apps: ['Blender'],
        outcome: 'done',
        openThreads: [],
        refs: []
      },
      facts: [{ layer: 'profile', fact: 'Is left-handed', confidence: 0.9, sensitive: false }]
    }))
    const ov = memoryOverview()
    expect(ov.profile.map((f) => f.text)).toEqual(['Likes detailed answers'])
    expect(ov.apps).toEqual([
      { id: 'blender', facts: [expect.objectContaining({ text: 'Uses 4.2 keymap' })] }
    ])
    expect(ov.pending.map((p) => p.fact)).toEqual(['Is left-handed'])
    expect(ov.episodeCount).toBe(1)

    expect(reviewProposal(r.queued[0].id, true)).toEqual({ ok: true })
    expect(memoryOverview().profile.map((f) => f.text)).toContain('Is left-handed')
    expect(reviewProposal('nope', false).ok).toBe(false)

    expect(listEpisodes().map((e) => e.title)).toEqual(['Bevel'])
    expect(listEpisodes('bevel')).toHaveLength(1)
    expect(listEpisodes('excel')).toHaveLength(0)

    expect(deleteAllMemory('delete please').ok).toBe(false)
    expect(files().length).toBeGreaterThan(0)
    const dir = memory().store.dir
    expect(deleteAllMemory('DELETE')).toEqual({ ok: true })
    expect(existsSync(dir)).toBe(false)
  })
})
