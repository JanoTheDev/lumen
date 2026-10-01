import { describe, expect, it } from 'vitest'
import {
  noTextField,
  RecordingClock,
  scratchpadOnFailure
} from '../../../src/main/speech/dictation/scratchpad'
import type { FocusTarget } from '../../../src/main/speech/dictation/terminal-guard'

const target = (over: Partial<FocusTarget> = {}): FocusTarget => ({
  process: 'explorer.exe',
  title: 'Downloads',
  uia: true,
  role: 'listitem',
  name: 'report.pdf',
  editable: false,
  password: false,
  valueTail: '',
  ...over
})

describe('noTextField', () => {
  it('is true for a known, non-text element', () => {
    expect(noTextField(target())).toBe(true)
    expect(noTextField(target({ role: 'button' }))).toBe(true)
  })

  it('types when focus is unknown, editable, a password, a terminal or maybe text', () => {
    expect(noTextField(target({ uia: false }))).toBe(false)
    expect(noTextField(target({ editable: true }))).toBe(false)
    expect(noTextField(target({ password: true }))).toBe(false)
    expect(noTextField(target({ process: 'windowsterminal.exe' }))).toBe(false)
    for (const role of ['document', 'group', 'custom', 'pane', 'edit'])
      expect(noTextField(target({ role }))).toBe(false)
  })

  it('keeps a failed insert into a non-editable element as a note', () => {
    expect(scratchpadOnFailure(target({ role: 'document' }))).toBe(true)
    expect(scratchpadOnFailure(target({ editable: true }))).toBe(false)
    expect(scratchpadOnFailure(target({ password: true }))).toBe(false)
    expect(scratchpadOnFailure(target({ uia: false }))).toBe(false)
  })
})

describe('RecordingClock', () => {
  it('measures one recording once', () => {
    const c = new RecordingClock()
    c.start(1000)
    c.stop(4000)
    c.stop(9000)
    expect(c.take(5000)).toBe(3000)
    expect(c.take(5000)).toBeUndefined()
  })

  it('is unknown without a stop, for a stale stop or an implausible length', () => {
    const c = new RecordingClock()
    c.start(0)
    expect(c.take(5000)).toBeUndefined()
    c.start(0)
    c.stop(2000)
    expect(c.take(2000 + 3 * 60_000)).toBeUndefined()
    c.start(0)
    c.stop(100)
    expect(c.take(200)).toBeUndefined()
    c.start(0)
    c.reset()
    c.stop(2000)
    expect(c.take(2000)).toBeUndefined()
  })
})
