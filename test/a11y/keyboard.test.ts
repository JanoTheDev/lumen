import { describe, expect, it } from 'vitest'
import { ScanKeyboardModel, keyboardScanLevel, predict } from '../../src/main/a11y/keyboard'
import type { ScanLevel, ScanResult } from '../../src/main/a11y/switch'

const typed = (kb: ScanKeyboardModel, ids: string[]): unknown[] =>
  ids.flatMap((id) => kb.press(id).steps)

describe('predict', () => {
  it('suggests frequent words for a prefix, never the prefix itself', () => {
    expect(predict('th')).toEqual(['the', 'that', 'this', 'they'])
    expect(predict('the')).not.toContain('the')
    expect(predict('')).toEqual([])
    expect(predict('zzzq')).toEqual([])
  })

  it('follows the case the user typed and ranks the user’s own words first', () => {
    expect(predict('Th')[0]).toBe('The')
    expect(predict('TH')[0]).toBe('THE')
    expect(predict('th', new Map([['thesaurus', 2]]))[0]).toBe('thesaurus')
  })
})

describe('ScanKeyboardModel', () => {
  it('types characters, with shift for one character and caps until turned off', () => {
    const kb = new ScanKeyboardModel()
    expect(typed(kb, ['shift', 'c:h', 'c:i'])).toEqual([
      { t: 'type', text: 'H' },
      { t: 'type', text: 'i' }
    ])
    expect(kb.shift).toBe(false)
    expect(typed(kb, ['caps', 'c:o', 'c:k', 'caps', 'c:!'])).toEqual([
      { t: 'type', text: 'O' },
      { t: 'type', text: 'K' },
      { t: 'type', text: '!' }
    ])
  })

  it('named keys send key combos; Close closes', () => {
    const kb = new ScanKeyboardModel()
    expect(typed(kb, ['enter', 'backspace', 'tab', 'left', 'right', 'esc'])).toEqual(
      ['enter', 'backspace', 'tab', 'left', 'right', 'esc'].map((combo) => ({ t: 'keys', combo }))
    )
    expect(kb.press('close')).toEqual({ steps: [], close: true })
    expect(kb.press('nope')).toEqual({ steps: [] })
  })

  it('tracks the word for suggestions and completes it with a space', () => {
    const kb = new ScanKeyboardModel()
    typed(kb, ['c:h', 'c:e', 'c:l'])
    expect(kb.word).toBe('hel')
    expect(kb.rows()[0].map((k) => k.label)).toEqual(['hello', 'help'])
    expect(kb.press('s:0').steps).toEqual([{ t: 'type', text: 'lo ' }])
    expect(kb.word).toBe('')
    expect(kb.rows()[0]).toEqual([])
    typed(kb, ['c:h', 'c:e', 'c:l', 'backspace'])
    expect(kb.word).toBe('he')
    typed(kb, ['space'])
    expect(kb.word).toBe('')
  })

  it('learns typed words and suggests them first next time', () => {
    const kb = new ScanKeyboardModel()
    typed(kb, ['c:h', 'c:e', 'c:l', 'c:i', 'c:x', 'space', 'c:h', 'c:e'])
    expect(kb.suggestions()[0]).toBe('helix')
  })

  it('shows letters upper case while shift or caps is on and marks the modifier', () => {
    const kb = new ScanKeyboardModel()
    kb.press('shift')
    const rows = kb.rows()
    expect(rows[2][0].label).toBe('Q')
    expect(rows[4].find((k) => k.id === 'shift')?.on).toBe(true)
    expect(rows[1].find((k) => k.id === 'backspace')?.name).toBe('Backspace')
  })
})

describe('keyboardScanLevel', () => {
  interface Setup {
    kb: ScanKeyboardModel
    level: ScanLevel
    pressed: string[]
    closed: () => number
    renders: () => number
  }
  function setup(): Setup {
    const kb = new ScanKeyboardModel()
    const pressed: string[] = []
    let closed = 0
    let renders = 0
    const level = keyboardScanLevel(kb, {
      press: async (id) => {
        pressed.push(id)
        const r = kb.press(id)
        void r
      },
      close: () => closed++,
      render: () => renders++
    })
    return { kb, level, pressed, closed: () => closed, renders: () => renders }
  }
  const push = (r: ScanResult): ScanLevel => (r as { push: ScanLevel }).push

  it('scans rows (suggestions first), then keys, and goes back to the rows after a key', async () => {
    const t = setup()
    expect(t.level.items.map((i) => i.label)[0]).toBe('No suggestions')
    expect(t.level.items[2].label).toMatch(/^Row 2: q w e r/)
    expect(await t.level.items[0].select()).toBe('stay')
    const row2 = push(await t.level.items[2].select())
    expect(row2.items[0].label).toBe('q')
    expect(await row2.items[0].select()).toBe('back')
    expect(t.pressed).toEqual(['c:q'])
    // The suggestion row label is live.
    expect(t.level.items[0].label).toMatch(/^Suggestions: /)
  })

  it('highlight follows the scan; Close and leaving the level close the keyboard', async () => {
    const t = setup()
    t.level.onHighlight?.(3)
    expect(t.kb.state().highlight).toEqual({ row: 3, key: null })
    const row5 = push(await t.level.items[5].select())
    row5.onHighlight?.(1)
    expect(t.kb.state().highlight).toEqual({ row: 5, key: 1 })
    const close = row5.items.find((i) => i.label === 'Close')!
    expect(await close.select()).toBe('root')
    expect(t.closed()).toBe(1)
    t.level.onExit?.()
    expect(t.closed()).toBe(2)
    expect(t.renders()).toBeGreaterThan(0)
  })
})
