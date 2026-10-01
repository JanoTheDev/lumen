import { describe, expect, it } from 'vitest'
import {
  readingLevelAppId,
  readingLevelLine,
  readingLevelLineFor
} from '../../src/main/coach/reading-level'
import { SYSTEM_PREFIX, systemBlocks, userTurn } from '../../src/main/ai/prompts/assemble'
import { lessonTurn, whyTurn } from '../../src/main/ai/prompts/lesson'

const cfg = { readingLevel: 'standard' as const, readingLevelApps: { excel: 'plain' as const } }

describe('reading level in prompts', () => {
  it('picks the per-app level, else the global one', () => {
    expect(readingLevelLineFor(cfg, 'excel')).toBe(readingLevelLine('plain'))
    expect(readingLevelLineFor(cfg, 'notepad')).toBe('')
    expect(readingLevelLineFor({ ...cfg, readingLevel: 'expert' }, null)).toMatch(/expert/)
  })

  it('keys apps like the coach: pack id, else the lowercased process name', () => {
    expect(readingLevelAppId('excel', 'C:\\x\\EXCEL.EXE')).toBe('excel')
    expect(readingLevelAppId(null, 'C:\\Windows\\Notepad.exe')).toBe('notepad')
    expect(readingLevelAppId(undefined, undefined)).toBeUndefined()
  })

  it('goes in the volatile user turn, never the cached system prefix', () => {
    const line = readingLevelLine('plain')
    const base = { prompt: 'what is this', activeWindow: 'Book1 - Excel', frame: null }
    const before = JSON.stringify(systemBlocks())
    const turn = userTurn({ ...base, readingLevel: line })
    expect(turn.slice(0, turn.indexOf('</context>'))).toContain(line)
    expect(userTurn({ ...base, readingLevel: '' })).not.toContain('Reading level')
    expect(JSON.stringify(systemBlocks())).toBe(before)
    expect(SYSTEM_PREFIX).not.toContain('Reading level: plain')
  })

  it('reaches the lesson and why turns', () => {
    const line = readingLevelLine('expert')
    expect(lessonTurn({ question: 'q', foreground: 'Excel', readingLevel: line })).toContain(line)
    expect(lessonTurn({ question: 'q', foreground: 'Excel' })).not.toContain('Reading level')
    const why = whyTurn({ app: 'Excel', lessonTitle: 't', step: 's', readingLevel: line })
    expect(why.slice(0, why.indexOf('</context>'))).toContain(line)
  })
})
