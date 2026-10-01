import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, type Harness } from './helpers'
import type { SessionSummary, Summarizer } from '../../src/main/ai/memory'

let h: Harness
afterEach(() => h?.cleanup())

const SUMMARY: SessionSummary = {
  episode: {
    title: 'Bevel in Blender',
    summary: 'Showed the bevel tool. Card 4111 1111 1111 1111 was mentioned.',
    apps: ['Blender'],
    outcome: 'done',
    openThreads: ['try chamfer'],
    refs: [
      { kind: 'url', value: 'https://docs.blender.org' },
      { kind: 'file', value: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }
    ]
  },
  facts: [
    { layer: 'profile', fact: 'Prefers short answers', confidence: 0.9, sensitive: false },
    { layer: 'app', fact: 'Uses the 4.2 hotkey preset', confidence: 0.95, sensitive: false },
    { layer: 'profile', fact: 'Might be left-handed', confidence: 0.5, sensitive: false },
    {
      layer: 'profile',
      fact: 'Has a doctor appointment Tuesday',
      confidence: 0.9,
      sensitive: true
    },
    { layer: 'profile', fact: 'password is hunter2', confidence: 0.99, sensitive: false }
  ]
}

const fake = (s: SessionSummary = SUMMARY): Summarizer & ReturnType<typeof vi.fn> =>
  vi.fn(async () => structuredClone(s)) as Summarizer & ReturnType<typeof vi.fn>

const talk = (h: Harness): void => {
  h.mem.session.add({ utterance: 'how do I bevel', answer: 'Press Ctrl+B', app: 'Blender' })
  h.mem.session.add({ utterance: 'my password is hunter2', app: 'Blender' })
}

describe('endSession', () => {
  it('auto mode: saves episode, applies confident facts, queues the rest, drops sensitive', async () => {
    h = harness({ autoLearn: 'auto' })
    talk(h)
    const summarize = fake()
    const r = await h.mem.endSession(summarize)
    expect(summarize.mock.calls[0][0]).not.toContain('hunter2')
    expect(r.status).toBe('saved')
    expect(r.applied.map((p) => p.fact)).toEqual([
      'Prefers short answers',
      'Uses the 4.2 hotkey preset'
    ])
    expect(r.queued.map((p) => p.fact)).toEqual(['Might be left-handed'])
    expect(r.dropped.map((p) => p.fact)).toEqual([
      'Has a doctor appointment Tuesday',
      'password is hunter2'
    ])
    expect(h.mem.apps.facts('Blender').map((f) => f.text)).toEqual(['Uses the 4.2 hotkey preset'])
    expect(h.mem.profile.facts()[0]).toMatchObject({ source: 'inferred' })
    expect(r.episode!.summary).toContain('[redacted:card]')
    expect(r.episode!.refs).toEqual([{ kind: 'url', value: 'https://docs.blender.org' }])
    expect(h.mem.session.turns()).toEqual([])
    expect(h.files().some((f) => f.startsWith('sessions/'))).toBe(false)
    const all = h.files().join('\n')
    expect(all).toContain('PROFILE.md')
    expect(h.mem.searchEpisodes('bevel')[0].episode.id).toBe(r.episode!.id)
  })

  it('never writes card numbers, keys or password text anywhere on disk', async () => {
    h = harness({ autoLearn: 'auto' })
    talk(h)
    h.mem.session.add({ utterance: 'S3cret!pass', sensitive: true })
    await h.mem.endSession(fake())
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const blob = h
      .files()
      .map((f) => readFileSync(join(h.dir, f), 'utf8'))
      .join('\n')
    expect(blob).not.toMatch(/4111|hunter2|sk-ant|S3cret/)
  })

  it('ask mode queues everything non-sensitive; accept and reject work', async () => {
    h = harness({ autoLearn: 'ask' })
    talk(h)
    const r = await h.mem.endSession(fake())
    expect(r.applied).toEqual([])
    expect(r.queued).toHaveLength(3)
    expect(h.mem.profile.facts()).toEqual([])
    expect(h.mem.acceptPending(r.queued[0].id)).toBe('added')
    expect(h.mem.rejectPending(r.queued[1].id)).toBe(true)
    expect(h.mem.pending().map((p) => p.fact)).toEqual(['Might be left-handed'])
    expect(h.mem.profile.facts().map((f) => f.text)).toEqual(['Prefers short answers'])
  })

  it('off mode saves the episode only', async () => {
    h = harness({ autoLearn: 'off' })
    talk(h)
    const r = await h.mem.endSession(fake())
    expect(r.status).toBe('saved')
    expect(r.queued).toEqual([])
    expect(h.files().filter((f) => !f.startsWith('episodes/'))).toEqual([])
  })

  it('private mode writes nothing and never calls the model', async () => {
    h = harness({ privateMode: true, autoLearn: 'auto' })
    talk(h)
    expect(h.mem.remember('My name is Jano')).toBe('disabled')
    expect(h.mem.session.turns()).toHaveLength(2)
    const summarize = fake()
    const r = await h.mem.endSession(summarize)
    expect(r.status).toBe('private')
    expect(summarize).not.toHaveBeenCalled()
    h.mem.buildMemoryContext('bevel', 'Blender')
    expect(h.files()).toEqual([])
  })

  it('memory disabled writes no episodes or facts', async () => {
    h = harness({ enabled: false, autoLearn: 'auto' })
    talk(h)
    const summarize = fake()
    const r = await h.mem.endSession(summarize)
    expect(r.status).toBe('disabled')
    expect(summarize).not.toHaveBeenCalled()
    expect(h.mem.remember('My name is Jano')).toBe('disabled')
    expect(h.files()).toEqual([])
  })

  it('keeps turns added while the summarizer runs', async () => {
    h = harness()
    talk(h)
    const r = h.mem.endSession(async () => {
      h.mem.session.add({ utterance: 'one more thing' })
      return structuredClone(SUMMARY)
    })
    await r
    expect(h.mem.session.turns().map((t) => t.utterance)).toEqual(['one more thing'])
  })

  it('keeps the session when the summarizer fails', async () => {
    h = harness()
    talk(h)
    await expect(
      h.mem.endSession(async () => Promise.reject(new Error('offline')))
    ).rejects.toThrow()
    expect(h.mem.session.turns()).toHaveLength(2)
  })

  it('does nothing for an empty session', async () => {
    h = harness()
    const summarize = fake()
    expect((await h.mem.endSession(summarize)).status).toBe('empty')
    expect(summarize).not.toHaveBeenCalled()
  })
})
