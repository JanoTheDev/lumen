import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from './helpers'
import {
  assembleContext,
  Bm25Index,
  createEpisodeIndex,
  estimateTokens,
  rankEpisodes,
  SqliteFtsIndex,
  tokenize
} from '../../src/main/ai/memory/retrieve'
import type { Episode } from '../../src/main/ai/memory/episodes'
import type { Fact } from '../../src/main/ai/memory/store'

let h: Harness
afterEach(() => h?.cleanup())

const NOW = new Date('2026-10-01T12:00:00Z')
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString()

const ep = (id: string, over: Partial<Episode>): Episode => ({
  id,
  date: daysAgo(1),
  title: 'Session',
  summary: '',
  apps: [],
  outcome: 'done',
  openThreads: [],
  refs: [],
  ...over
})

const FIXTURES: Episode[] = [
  ep('bevel-blender', {
    title: 'Bevel edges in Blender',
    summary: 'Used Ctrl+B to bevel the cube edges for the 3D print.',
    apps: ['Blender'],
    date: daysAgo(2)
  }),
  ep('bevel-old', {
    title: 'Bevel edges in Blender',
    summary: 'Used Ctrl+B to bevel the cube edges for the 3D print.',
    apps: ['Blender'],
    date: daysAgo(120)
  }),
  ep('export-resolve', {
    title: 'Export error in Resolve',
    summary: 'Render failed with a codec error; switched export to H.264.',
    apps: ['Resolve'],
    date: daysAgo(3),
    openThreads: ['retry the 4K export']
  }),
  ep('export-blender', {
    title: 'Export STL from Blender',
    summary: 'Exported the model as STL for the printer.',
    apps: ['Blender'],
    date: daysAgo(3)
  }),
  ep('tutorial-link', {
    title: 'Found a sculpting tutorial',
    summary: 'Watched a sculpting tutorial video.',
    apps: ['Chrome'],
    date: daysAgo(6),
    refs: [{ kind: 'url', value: 'https://youtube.com/watch?v=sculpt101' }]
  })
]

function indexed(kind: 'json' | 'auto'): { rank: (q: string, app?: string) => string[] } {
  const index = kind === 'json' ? new Bm25Index() : createEpisodeIndex('auto')
  const byId = new Map(FIXTURES.map((e) => [e.id, e]))
  for (const e of FIXTURES) index.upsert(e)
  return {
    rank: (q, app) =>
      rankEpisodes(index, (id) => byId.get(id), q, { app, now: NOW, limit: 5 }).map(
        (r) => r.episode.id
      )
  }
}

describe('tokenize', () => {
  it('drops stopwords and punctuation', () => {
    expect(tokenize('What did we do in Blender, yesterday?')).toEqual(['blender'])
  })
})

describe.each(['json', 'auto'] as const)('episode ranking (%s index)', (kind) => {
  it('ranks the matching episode first', () => {
    expect(indexed(kind).rank('bevel edges')[0]).toBe('bevel-blender')
  })

  it('prefers recent over old for equal text (30-day half-life)', () => {
    const r = indexed(kind).rank('bevel edges')
    expect(r.indexOf('bevel-blender')).toBeLessThan(r.indexOf('bevel-old'))
  })

  it('boosts the foreground app ×2', () => {
    expect(indexed(kind).rank('export', 'Blender')[0]).toBe('export-blender')
  })

  it('boosts open threads ×1.5 when apps are equal', () => {
    expect(indexed(kind).rank('export')[0]).toBe('export-resolve')
  })

  it('searches refs', () => {
    expect(indexed(kind).rank('sculpt101')).toEqual(['tutorial-link'])
  })

  it('returns nothing for no overlap', () => {
    expect(indexed(kind).rank('spreadsheet budget')).toEqual([])
  })
})

describe('index backend', () => {
  it('falls back to JSON BM25 when FTS5 is unavailable and honours an explicit choice', () => {
    const auto = createEpisodeIndex('auto')
    expect(auto.backend).toBe(SqliteFtsIndex.tryCreate() ? 'sqlite-fts5' : 'json-bm25')
    expect(createEpisodeIndex('json-bm25').backend).toBe('json-bm25')
  })
})

const fact = (section: string, text: string): Fact => ({ section, text, source: 'said' })

describe('assembleContext cap + priority', () => {
  const profile = [
    fact('Access needs', 'Uses dwell clicking; needs large text'),
    fact('Name', 'Call them Jano'),
    fact('Preferences', 'Prefers short answers'),
    fact('Goals', 'Learning Blender for 3D printing ' + 'x'.repeat(200))
  ]

  it('orders profile, app, working, episodes', () => {
    const out = assembleContext({
      profile: profile.slice(0, 2),
      app: { name: 'Blender', facts: [fact('Notes', 'Uses the 4.2 hotkey preset')] },
      working: [fact('Current', 'Halfway through lesson 3')],
      episodes: [FIXTURES[0]]
    })
    const order = ['dwell', 'Jano', 'hotkey preset', 'lesson 3', 'Bevel edges'].map((s) =>
      out.indexOf(s)
    )
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(out.startsWith('<memory>') && out.endsWith('</memory>')).toBe(true)
  })

  it('trims lowest priority first and never exceeds the cap', () => {
    const parts = {
      profile,
      working: [fact('Current', 'Halfway through lesson 3')],
      episodes: FIXTURES
    }
    const full = assembleContext(parts, 10_000)
    for (const cap of [20, 40, 60, 90, 150, 300]) {
      const out = assembleContext(parts, cap)
      expect(estimateTokens(out)).toBeLessThanOrEqual(cap)
      expect(full.startsWith(out.replace(/\n<\/memory>$/, ''))).toBe(true)
    }
    const small = assembleContext(parts, 40)
    expect(small).toContain('dwell')
    expect(small).not.toContain('Learning Blender')
    expect(small).not.toContain('Related past sessions')
  })

  it('returns empty when nothing fits or nothing exists', () => {
    expect(assembleContext({ profile: [], working: [], episodes: [] })).toBe('')
    expect(assembleContext({ profile, working: [], episodes: [] }, 3)).toBe('')
  })
})

describe('buildMemoryContext', () => {
  it('injects profile, foreground app, working and relevant episodes', () => {
    h = harness()
    h.mem.remember('I use dwell clicking')
    h.mem.remember('Project is 4K 25fps', { layer: 'app', app: 'Resolve' })
    h.mem.remember('Halfway through lesson 3', { layer: 'working' })
    h.mem.episodes.save({ ...FIXTURES[2] })
    const out = h.mem.buildMemoryContext('the export failed again', 'Resolve')
    expect(out).toContain('dwell clicking')
    expect(out).toContain('Notes for Resolve:\n- Project is 4K 25fps')
    expect(out).toContain('lesson 3')
    expect(out).toContain('Export error in Resolve')
    expect(h.mem.buildMemoryContext('anything', 'Resolve', 10)).toBe('')
  })

  it('returns nothing when memory is off', () => {
    h = harness()
    h.mem.remember('I use dwell clicking')
    h.settings.enabled = false
    expect(h.mem.buildMemoryContext('hi')).toBe('')
  })
})
