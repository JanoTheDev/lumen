import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clip = vi.hoisted(() => ({ writeText: vi.fn(), readText: vi.fn(() => '') }))
vi.mock('electron', async () => {
  const m = (await import('../helpers/electron-mock')).electronModule()
  return { ...m, clipboard: clip, default: { ...m.default, clipboard: clip } }
})
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { setConfigDir } from '../../src/main/config'
import * as assistant from '../../src/main/windows/assistant'
import { tempDir } from '../helpers/fixtures'

describe('answer card and notice buttons by voice (assistant bar)', () => {
  let tmp: ReturnType<typeof tempDir>
  const say = vi.fn()
  const spoken = vi.fn((text: string) => {
    void text
    return true
  })

  beforeEach(() => {
    vi.useFakeTimers()
    tmp = tempDir()
    setConfigDir(tmp.dir)
    say.mockReset()
    spoken.mockClear()
    clip.writeText.mockClear()
    assistant.setAnnouncer(say)
    assistant.setRepeatSpeaker(spoken)
  })
  afterEach(() => {
    assistant.setNotice(undefined)
    assistant.close()
    assistant.setRepeatSpeaker(() => false)
    vi.useRealTimers()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('keeps the last answer for two minutes after the next recording hid it', () => {
    assistant.showAnswer('The **capital** is Paris.')
    // The user holds the hotkey to say "repeat that": the card is gone from the bar.
    assistant.open('listening')
    expect(assistant.answerShown()).toBe(false)
    expect(assistant.recentAnswer()).toBe('The **capital** is Paris.')
    vi.advanceTimersByTime(assistant.RECENT_ANSWER_MS + 1)
    expect(assistant.recentAnswer()).toBeNull()
  })

  it('"repeat that" shows the answer again and speaks it once as plain text', () => {
    assistant.showAnswer('The **capital** is [Paris](https://example.org).')
    assistant.open('listening')
    expect(assistant.repeatAnswer()).toBe(true)
    expect(assistant.state().answer?.markdown).toBe(
      'The **capital** is [Paris](https://example.org).'
    )
    expect(spoken).toHaveBeenCalledWith('The capital is Paris.')
    expect(say).not.toHaveBeenCalledWith(expect.anything(), { kind: 'answer' })
  })

  it('falls back to the announce policy when nothing could speak it', () => {
    assistant.setRepeatSpeaker(() => false)
    assistant.showAnswer('Hello')
    expect(assistant.repeatAnswer()).toBe(true)
    expect(say).toHaveBeenCalledWith('Hello', { kind: 'answer' })
  })

  it('the Repeat button speaks through the same path', () => {
    assistant.showAnswer('Hello there')
    assistant.command({ type: 'repeat' })
    expect(spoken).toHaveBeenCalledWith('Hello there')
  })

  it('nothing to repeat or copy without a recent answer', () => {
    vi.advanceTimersByTime(assistant.RECENT_ANSWER_MS + 1)
    expect(assistant.repeatAnswer()).toBe(false)
    expect(assistant.copyAnswer()).toBe(false)
    expect(clip.writeText).not.toHaveBeenCalled()
  })

  it('"copy the answer" puts the answer text on the clipboard', () => {
    assistant.showAnswer('Line one')
    assistant.open('listening')
    expect(assistant.copyAnswer()).toBe(true)
    expect(clip.writeText).toHaveBeenCalledWith('Line one')
  })

  it('remembers the notice button through the recording, until it is cleared', () => {
    assistant.setNotice({ text: 'Rewrote the selection', action: 'undo' })
    assistant.open('listening')
    expect(assistant.state().notice).toBeUndefined()
    expect(assistant.noticeAction()).toBe('undo')
    assistant.setNotice(undefined)
    expect(assistant.noticeAction()).toBeNull()
  })

  it('an old notice no longer counts', () => {
    assistant.setNotice({ text: 'Sound is muted', action: 'unmute' })
    expect(assistant.noticeAction()).toBe('unmute')
    assistant.open('listening')
    vi.advanceTimersByTime(assistant.RECENT_ANSWER_MS + 1)
    expect(assistant.noticeAction()).toBeNull()
  })

  it('the notice buttons reach their handlers', () => {
    const undo = vi.fn()
    const unmute = vi.fn()
    assistant.setUndoHandler(undo)
    assistant.setUnmuteHandler(unmute)
    assistant.command({ type: 'undo' })
    assistant.command({ type: 'unmute' })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(unmute).toHaveBeenCalledTimes(1)
  })
})
