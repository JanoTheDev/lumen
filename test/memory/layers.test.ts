import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { harness, type Harness } from './helpers'
import { classifyProfileFact } from '../../src/main/ai/memory/profile'
import { parseEpisode, serializeEpisode } from '../../src/main/ai/memory/episodes'
import { createMemory } from '../../src/main/ai/memory'

let h: Harness
afterEach(() => h?.cleanup())

describe('profile + app facts', () => {
  it('writes human-readable markdown with date and source', () => {
    h = harness()
    expect(h.mem.remember('I use dwell clicking')).toBe('added')
    expect(h.mem.remember('My name is Jano')).toBe('added')
    const md = readFileSync(join(h.dir, 'PROFILE.md'), 'utf8')
    expect(md).toContain('## Access needs\n- I use dwell clicking <!-- 2026-10-01 · said -->')
    expect(md.indexOf('## Access needs')).toBeLessThan(md.indexOf('## Name'))
  })

  it('classifies facts into sections', () => {
    expect(classifyProfileFact('I use dwell clicking')).toBe('Access needs')
    expect(classifyProfileFact('Call me Jano')).toBe('Name')
    expect(classifyProfileFact('I prefer short answers')).toBe('Preferences')
    expect(classifyProfileFact('Learning Blender for 3D printing')).toBe('Goals')
  })

  it('dedupes identical facts by refreshing the date', () => {
    h = harness()
    h.mem.remember('I prefer short answers')
    h.clock.now = new Date('2026-10-05T12:00:00Z')
    expect(h.mem.remember('i prefer short answers!')).toBe('refreshed')
    const facts = h.mem.profile.facts()
    expect(facts).toHaveLength(1)
    expect(facts[0].date).toBe('2026-10-05')
  })

  it('replaces a contradicting fact and keeps the old line in history', () => {
    h = harness()
    h.mem.remember('My name is Jan')
    expect(h.mem.remember('My name is Jano')).toBe('replaced')
    expect(h.mem.profile.facts().map((f) => f.text)).toEqual(['My name is Jano'])
    const hist = readFileSync(join(h.dir, 'PROFILE.history.md'), 'utf8')
    expect(hist).toContain('replaced "My name is Jan"')
  })

  it('replaces via an explicit replaces hint', () => {
    h = harness()
    h.mem.remember('Uses the default keymap', { layer: 'app', app: 'blender.exe' })
    h.mem.remember('Uses the Blender 4.2 hotkey preset', {
      layer: 'app',
      app: 'Blender',
      replaces: 'Uses the default keymap'
    })
    expect(h.mem.apps.facts('blender').map((f) => f.text)).toEqual([
      'Uses the Blender 4.2 hotkey preset'
    ])
    expect(h.files()).toContain('apps/blender.history.md')
  })

  it('rejects sensitive facts', () => {
    h = harness()
    expect(h.mem.remember('my password is hunter2')).toBe('rejected')
    expect(h.mem.remember('card 4111 1111 1111 1111')).toBe('rejected')
    expect(h.files()).toEqual([])
  })

  it('reads hand-edited lines and forgets matching facts', () => {
    h = harness()
    h.mem.remember('Prefers short answers')
    writeFileSync(
      join(h.dir, 'PROFILE.md'),
      readFileSync(join(h.dir, 'PROFILE.md'), 'utf8') + '- Likes dark themes\n'
    )
    expect(h.mem.profile.facts().map((f) => f.text)).toContain('Likes dark themes')
    expect(h.mem.forget('dark')).toBe(1)
    expect(h.mem.profile.facts().map((f) => f.text)).toEqual(['Prefers short answers'])
  })
})

describe('working memory', () => {
  it('expires facts after 14 days unless refreshed', () => {
    h = harness()
    h.mem.remember('Halfway through lesson 3', { layer: 'working' })
    h.mem.remember('Fixing the export error', { layer: 'working' })
    h.clock.now = new Date('2026-10-10T12:00:00Z')
    h.mem.remember('Fixing the export error', { layer: 'working' })
    h.clock.now = new Date('2026-10-16T12:00:00Z')
    expect(h.mem.working.facts().map((f) => f.text)).toEqual(['Fixing the export error'])
    expect(h.mem.working.prune()).toBe(1)
  })
})

describe('session layer', () => {
  it('survives a restart via sessions/current.jsonl', () => {
    h = harness()
    h.mem.session.add({ utterance: 'how do I bevel', answer: 'Press Ctrl+B', app: 'Blender' })
    const again = createMemory({ dir: h.dir, settings: () => h.settings, log: () => {} })
    expect(again.session.turns().map((t) => t.utterance)).toEqual(['how do I bevel'])
    again.session.clear()
    expect(h.files()).toEqual([])
  })

  it('redacts secrets and password-field text before keeping a turn', () => {
    h = harness()
    h.mem.session.add({ utterance: 'type sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 here' })
    h.mem.session.add({ utterance: 'Tr0ub4dor&3', sensitive: true })
    const disk = readFileSync(join(h.dir, 'sessions/current.jsonl'), 'utf8')
    expect(disk).not.toContain('sk-ant')
    expect(disk).not.toContain('Tr0ub4dor')
    expect(h.mem.session.transcript()).not.toContain('Tr0ub4dor')
  })

  it('reports a stale session after 30 min idle', () => {
    h = harness()
    h.mem.session.add({ utterance: 'hi' })
    expect(h.mem.session.isStale()).toBe(false)
    h.clock.now = new Date('2026-10-01T12:31:00Z')
    expect(h.mem.session.isStale()).toBe(true)
  })
})

describe('episodes', () => {
  it('round-trips through markdown and prunes by retention', () => {
    h = harness()
    const e = h.mem.episodes.save({
      title: 'Bevel in Blender',
      summary: 'Learned the bevel tool.',
      apps: ['Blender'],
      outcome: 'done',
      openThreads: ['try a chamfer'],
      refs: [{ kind: 'url', value: 'https://docs.blender.org/bevel' }]
    })
    expect(h.files()).toContain(`episodes/2026-10/${e.id}.md`)
    expect(parseEpisode(serializeEpisode(e))).toEqual(e)
    expect(h.mem.episodes.get(e.id)).toEqual(e)
    h.clock.now = new Date('2027-11-01T12:00:00Z')
    expect(h.mem.episodes.prune(365)).toEqual([e.id])
    expect(h.mem.episodes.list()).toEqual([])
  })
})
