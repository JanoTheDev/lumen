import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from './helpers'
import { MEMORY_SEARCH_TOOL, memorySearch } from '../../src/main/ai/memory'
import { localSummary } from '../../src/main/ai/memory/runtime'

let h: Harness
afterEach(() => h?.cleanup())

describe('memory_search tool', () => {
  it('finds past sessions with their links and matching facts', () => {
    h = harness()
    h.mem.episodes.save({
      title: 'Blender export tutorial',
      summary: 'You followed a tutorial on exporting STL files for printing.',
      apps: ['Blender'],
      outcome: 'partial',
      openThreads: ['export still fails at 80%'],
      refs: [{ kind: 'url', value: 'https://example.com/stl-export' }]
    })
    h.mem.episodes.save({
      title: 'Gmail filters',
      summary: 'You set up a filter for invoices.',
      apps: ['Gmail'],
      outcome: 'done',
      openThreads: [],
      refs: []
    })
    h.mem.remember('Prints on a Prusa MK4 printer')
    h.mem.remember('Uses the 4.2 hotkey preset', { layer: 'app', app: 'Blender' })

    const out = memorySearch(h.mem, { query: 'tutorial link for printer export', app: 'Blender' })
    expect(out).toContain('Prints on a Prusa MK4 printer')
    expect(out).toContain('Uses the 4.2 hotkey preset')
    expect(out).toContain('Blender export tutorial (partial)')
    expect(out).toContain('url: https://example.com/stl-export')
    expect(out).toContain('open: export still fails at 80%')
    expect(out).not.toContain('Gmail filters')
    expect(memorySearch(h.mem, { query: 'zebra' })).toBe('Nothing saved matches "zebra".')
    expect(MEMORY_SEARCH_TOOL.schema.parse({ query: 'x' })).toEqual({ query: 'x' })
  })

  it('says memory is off instead of reading', () => {
    h = harness({ enabled: false })
    expect(memorySearch(h.mem, { query: 'anything' })).toMatch(/Memory is off/)
  })

  it('keeps the running lesson in the session and in the plain summary', () => {
    h = harness()
    h.mem.session.add({ utterance: 'what does this do', app: 'Blender', lesson: 'Bevel basics' })
    expect(h.mem.session.transcript()).toContain('lesson "Bevel basics"')
    expect(localSummary(h.mem.session.turns()).episode.refs).toEqual([
      { kind: 'lesson', value: 'Bevel basics' }
    ])
  })
})
