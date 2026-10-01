import { describe, expect, it } from 'vitest'
import {
  BREAK_AFTER_MS,
  FatigueTracker,
  MisfireWatch,
  utteranceSignals,
  WINDOW_MS
} from '../../src/main/coach/fatigue'
import { makeConfig } from '../helpers/fixtures'

const cfg = makeConfig({ dwellClick: { enabled: true, dwellMs: 1400 }, voice: { tts: 'windows' } })

describe('fatigue signals', () => {
  it('reads corrections, repeats and retries from utterances', () => {
    expect(utteranceSignals('No, I said Paint', null, 0)).toEqual(['voice-correction'])
    expect(utteranceSignals('say that again', null, 0)).toEqual(['repeat-request'])
    expect(utteranceSignals('try again', null, 0)).toEqual(['retry'])
    expect(utteranceSignals('open paint', { text: 'Open paint', at: 0 }, 30_000)).toEqual(['retry'])
    expect(utteranceSignals('open paint', { text: 'open paint', at: 0 }, 90_000)).toEqual([])
  })

  it('a dwell click undone or escaped within 2 s is a misfire', () => {
    const w = new MisfireWatch()
    w.onDwellClick(1000)
    expect(w.onCombo('Ctrl+Z', 2500)).toBe(true)
    expect(w.onCombo('Ctrl+Z', 2600)).toBe(false)
    w.onDwellClick(5000)
    expect(w.onCombo('Escape', 8000)).toBe(false)
  })
})

describe('FatigueTracker', () => {
  it('proposes a bigger dwell ring after three misfires, never changing anything itself', () => {
    const t = new FatigueTracker({ answers: {} })
    t.note('dwell-misfire', 0)
    t.note('dwell-misfire', 1)
    expect(t.propose(cfg, 2)).toBeNull()
    t.note('dwell-misfire', 2)
    const p = t.propose(cfg, 3)!
    expect(p.id).toBe('bigger-dwell')
    expect(p.patch).toEqual({ a11y: { dwell: { ringSize: 'l' } }, dwellClick: { dwellMs: 1700 } })
    expect(cfg.dwellClick.dwellMs).toBe(1400)
  })

  it('signals age out of the window', () => {
    const t = new FatigueTracker({ answers: {} })
    for (let i = 0; i < 3; i++) t.note('voice-correction', i)
    t.note('voice-correction', WINDOW_MS + 10)
    expect(t.propose(cfg, WINDOW_MS + 10)).toBeNull()
  })

  it('remembers answers: no is not asked again for a week, yes never', () => {
    const t = new FatigueTracker({ answers: {} })
    for (let i = 0; i < 3; i++) t.note('voice-correction', i)
    expect(t.propose(cfg, 3)?.id).toBe('numbers')
    t.answer('numbers', false, 3)
    for (let i = 0; i < 3; i++) t.note('voice-correction', 4 + i)
    expect(t.propose(cfg, 10)).toBeNull()
    expect(t.snapshot().answers.numbers).toEqual({ answer: 'no', at: 3 })
    t.answer('numbers', true, 20)
    for (let i = 0; i < 3; i++) t.note('voice-correction', 8 * 86_400_000 + i)
    expect(t.propose(cfg, 8 * 86_400_000 + 5)).toBeNull()
  })

  it('slower speech only when Lumen speaks', () => {
    const t = new FatigueTracker({ answers: {} })
    for (let i = 0; i < 3; i++) t.note('repeat-request', i)
    expect(t.propose(cfg, 3)?.patch).toEqual({ voice: { ttsRate: 0.85 } })
    const silent = makeConfig({ voice: { tts: 'off' } })
    expect(t.propose(silent, 3)).toBeNull()
  })

  it('suggests a break after long continuous use, once per stretch', () => {
    const t = new FatigueTracker({ answers: {} })
    for (let m = 0; m <= 50; m += 5) t.note('activity', m * 60_000)
    const now = BREAK_AFTER_MS
    expect(t.propose(cfg, now)?.id).toBe('break')
    expect(t.propose(cfg, now + 1000)).toBeNull()
  })
})
