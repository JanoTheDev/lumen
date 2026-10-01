import { describe, expect, it, vi } from 'vitest'
import { Announcer, type AnnounceDeps } from '../../src/main/a11y/announce'
import { atState, screenReaderActive, setAtState } from '../../src/main/a11y/at-state'

function setup(over: Partial<AnnounceDeps> = {}): {
  a: Announcer
  sr: ReturnType<typeof vi.fn>
  speak: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  tick: (ms: number) => number
} {
  let t = 0
  const sr = vi.fn(async () => true)
  const speak = vi.fn()
  const publish = vi.fn()
  const deps: AnnounceDeps = {
    now: () => t,
    enabled: () => true,
    screenReaderActive: () => false,
    ttsOn: () => false,
    sendToScreenReader: sr,
    speak,
    publish,
    ...over
  }
  return { a: new Announcer(deps), sr, speak, publish, tick: (ms: number) => (t += ms) }
}

const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

describe('announce routing matrix', () => {
  it.each([
    // enabled, screen reader, tts → via
    [true, true, false, 'sr'],
    [true, true, true, 'sr'],
    [true, false, true, 'tts'],
    [true, false, false, 'none'],
    [false, true, true, 'none'],
    [false, false, true, 'none']
  ] as const)('enabled=%s sr=%s tts=%s → %s', (enabled, srOn, tts, via) => {
    const { a, sr, speak, publish } = setup({
      enabled: () => enabled,
      screenReaderActive: () => srOn,
      ttsOn: () => tts
    })
    expect(a.announce('Opening Gmail').via).toBe(via)
    expect(sr).toHaveBeenCalledTimes(via === 'sr' ? 1 : 0)
    // No double speech: TTS never runs alongside a screen reader that took the text.
    expect(speak).toHaveBeenCalledTimes(via === 'tts' ? 1 : 0)
    expect(publish).toHaveBeenCalledWith('Opening Gmail', 'polite', via, 'status')
  })

  it('falls back to TTS when the screen reader did not take the text', async () => {
    const { a, speak } = setup({
      screenReaderActive: () => true,
      ttsOn: () => true,
      sendToScreenReader: async () => false
    })
    a.announce('Done')
    await flush()
    expect(speak).toHaveBeenCalledWith('Done')
  })

  it('stays quiet on fallback when TTS is off', async () => {
    const { a, speak } = setup({
      screenReaderActive: () => true,
      sendToScreenReader: async () => {
        throw new Error('agent down')
      }
    })
    a.announce('Done')
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })

  it('tells the bar when nobody spoke it after all', async () => {
    const unspoken = vi.fn()
    const { a, speak } = setup({
      screenReaderActive: () => true,
      sendToScreenReader: async () => false,
      unspoken
    })
    a.announce('Scrolled down', { kind: 'command' })
    await flush()
    expect(speak).not.toHaveBeenCalled()
    expect(unspoken).toHaveBeenCalledWith('Scrolled down', 'polite', 'command')
  })

  it('phase changes go to a screen reader but never to TTS', async () => {
    const { a, speak, publish } = setup({ ttsOn: () => true })
    expect(a.announce('Thinking', { kind: 'phase' }).via).toBe('none')
    expect(speak).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledWith('Thinking', 'polite', 'none', 'phase')
    const unspoken = vi.fn()
    const b = setup({
      ttsOn: () => true,
      screenReaderActive: () => true,
      sendToScreenReader: async () => false,
      unspoken
    })
    expect(b.a.announce('Thinking', { kind: 'phase' }).via).toBe('sr')
    await flush()
    expect(b.speak).not.toHaveBeenCalled()
    expect(unspoken).toHaveBeenCalledOnce()
  })

  it('errors default to assertive', () => {
    const { a, sr } = setup({ screenReaderActive: () => true })
    a.announce('Could not click', { kind: 'error' })
    expect(sr).toHaveBeenCalledWith('Could not click', 'assertive')
  })
})

describe('announce throttle and de-duplication', () => {
  it('throttles status to one per 1.5 s', () => {
    const { a, tick } = setup({ ttsOn: () => true })
    expect(a.announce('Thinking').dropped).toBeUndefined()
    tick(500)
    expect(a.announce('Looking at the screen').dropped).toBe('throttled')
    tick(1100)
    expect(a.announce('Clicking').dropped).toBeUndefined()
  })

  it('assertive interrupts the throttle', () => {
    const { a, tick } = setup()
    a.announce('Thinking')
    tick(100)
    expect(a.announce('Stopped', { priority: 'assertive' }).dropped).toBeUndefined()
  })

  it('drops identical text within 3 s across kinds', () => {
    const { a, tick } = setup()
    a.announce('Scrolling', { kind: 'command' })
    tick(1000)
    expect(a.announce('Scrolling', { kind: 'answer' }).dropped).toBe('duplicate')
    tick(2500)
    expect(a.announce('Scrolling', { kind: 'answer' }).dropped).toBeUndefined()
  })

  it('scan item names repeat freely and do not block the same text elsewhere', () => {
    const { a, tick } = setup()
    expect(a.announce('Back', { kind: 'scan' }).dropped).toBeUndefined()
    tick(100)
    expect(a.announce('Back', { kind: 'scan' }).dropped).toBeUndefined()
    expect(a.announce('Back', { kind: 'command' }).dropped).toBeUndefined()
  })

  it('kinds are throttled independently', () => {
    const { a } = setup()
    a.announce('Thinking')
    expect(a.announce('Step 1 of 3', { kind: 'step' }).dropped).toBeUndefined()
    expect(a.announce('', { kind: 'step' }).dropped).toBe('empty')
  })
})

describe('assistive tech state', () => {
  it('accepts the agent reply and ignores junk', () => {
    expect(setAtState({ screenReader: 'nvda', voiceControl: ['dragon'] })).toBe(true)
    expect(screenReaderActive()).toBe(true)
    expect(setAtState({ screenReader: 'nvda', voiceControl: ['dragon'] })).toBe(false)
    setAtState({ screenReader: 'evil', voiceControl: [1, 'voice-access'] })
    expect(atState()).toEqual({ screenReader: null, voiceControl: ['voice-access'] })
    expect(setAtState(null)).toBe(false)
  })
})
