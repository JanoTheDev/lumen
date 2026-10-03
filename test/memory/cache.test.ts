// Parsed fact files are reused until the file changes; the episode index can be built ahead of the
// first search with asynchronous reads.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { harness, type Harness } from './helpers'

let h: Harness
afterEach(() => h?.cleanup())

const reads = (spy: { mock: { calls: unknown[][] } }, rel: string): number =>
  spy.mock.calls.filter(([r]) => r === rel).length

function seedEpisodes(n: number): void {
  for (let i = 0; i < n; i++) {
    h.clock.now = new Date(Date.parse('2026-09-01T12:00:00Z') + i * 60_000)
    h.mem.episodes.save({
      title: `Exported render ${i}`,
      summary: `You exported the Blender render number ${i}.`,
      apps: ['Blender'],
      outcome: 'done',
      openThreads: [],
      refs: []
    })
  }
  h.clock.now = new Date('2026-10-01T12:00:00Z')
}

describe('fact file cache', () => {
  it('reads each fact file once across calls and again after remember()', () => {
    h = harness()
    h.mem.remember('Prefers short answers')
    h.mem.remember('Blender uses 4K 25fps', { layer: 'app', app: 'blender' })
    h.mem.remember('Building a cabin model', { layer: 'working' })
    const read = vi.spyOn(h.mem.store, 'read')
    const first = h.mem.buildMemoryContext('hello', 'blender')
    const second = h.mem.buildMemoryContext('hello', 'blender')
    expect(second).toBe(first)
    expect(first).toContain('Prefers short answers')
    expect(reads(read, 'PROFILE.md')).toBe(1)
    expect(reads(read, 'apps/blender.md')).toBe(1)
    expect(reads(read, 'VOLATILE.md')).toBe(1)

    h.mem.remember('Name: Jano')
    const third = h.mem.buildMemoryContext('hello', 'blender')
    expect(third).toContain('Name: Jano')
    expect(reads(read, 'PROFILE.md')).toBe(2)
    expect(reads(read, 'apps/blender.md')).toBe(1)
  })

  it('picks up a file edited by hand and a deleted file', () => {
    h = harness()
    h.mem.remember('Prefers short answers')
    expect(h.mem.profile.facts().map((f) => f.text)).toEqual(['Prefers short answers'])
    const path = join(h.dir, 'PROFILE.md')
    writeFileSync(path, '# About you\n\n## Preferences\n- Prefers long answers please\n')
    expect(h.mem.profile.facts().map((f) => f.text)).toEqual(['Prefers long answers please'])
    // Same size, new time.
    writeFileSync(path, '# About you\n\n## Preferences\n- Prefers bold answers please\n')
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    expect(h.mem.profile.facts().map((f) => f.text)).toEqual(['Prefers bold answers please'])
    h.mem.forget('answers')
    expect(h.mem.profile.facts()).toEqual([])
    h.mem.store.remove('PROFILE.md')
    expect(h.mem.profile.facts()).toEqual([])
  })

  it('hands out copies, so a caller cannot change the cached facts', () => {
    h = harness()
    h.mem.remember('Prefers short answers')
    const facts = h.mem.profile.file.read()
    facts[0].text = 'changed'
    facts.push({ section: 'Other', text: 'extra', source: 'said' })
    expect(h.mem.profile.file.read().map((f) => f.text)).toEqual(['Prefers short answers'])
  })
})

describe('episode index warm-up', () => {
  it('builds the index without synchronous reads and ranks like the on-demand build', async () => {
    h = harness()
    seedEpisodes(30)
    const cold = harness({}, h.dir)
    const expected = cold.mem.searchEpisodes('blender render 7', 'Blender').map((r) => r.episode.id)

    const read = vi.spyOn(h.mem.store, 'read')
    await h.mem.warmIndex()
    const got = h.mem.searchEpisodes('blender render 7', 'Blender').map((r) => r.episode.id)
    expect(got).toEqual(expected)
    expect(got.length).toBeGreaterThan(0)
    expect(read.mock.calls.filter(([r]) => String(r).startsWith('episodes/'))).toEqual([])
  })

  it('leaves the index to the next search when an episode is deleted meanwhile', async () => {
    h = harness()
    seedEpisodes(3)
    const victim = h.mem.episodes.list()[0].id
    const warm = h.mem.warmIndex()
    expect(h.mem.deleteEpisode(victim)).toBe(true)
    await warm
    const ids = h.mem.searchEpisodes('blender render', 'Blender', 10).map((r) => r.episode.id)
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(victim)
  })

  it('shares one run between calls and is a no-op once the index exists', async () => {
    h = harness()
    seedEpisodes(2)
    const list = vi.spyOn(h.mem.episodes, 'listAsync')
    await Promise.all([h.mem.warmIndex(), h.mem.warmIndex()])
    await h.mem.warmIndex()
    expect(list).toHaveBeenCalledTimes(1)
  })
})
