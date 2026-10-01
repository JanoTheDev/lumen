import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { bus } from '../src/main/bus'
import { saveConfig, loadConfig, setConfigDir } from '../src/main/config'
import { setAtState } from '../src/main/a11y/at-state'
import * as assistant from '../src/main/windows/assistant'
import { tempDir } from './helpers/fixtures'

type Via = 'sr' | 'tts' | 'none'
const announced = (text: string, kind: string, via: Via = 'none'): void =>
  bus.emit({ type: 'a11y.announce', text, priority: 'polite', kind, via })

describe('assistant bar accessibility (06 T11 / T14)', () => {
  let tmp: ReturnType<typeof tempDir>
  const say = vi.fn()
  let off = (): void => {}

  beforeEach(() => {
    vi.useFakeTimers()
    tmp = tempDir()
    setConfigDir(tmp.dir)
    say.mockReset()
    assistant.setAnnouncer(say)
    off = bus.on('a11y.announce', assistant.onAnnounce)
  })
  afterEach(() => {
    off()
    assistant.close()
    assistant.consumeDenied()
    setAtState({ screenReader: null })
    vi.useRealTimers()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('announces phases, steps and errors once; listening is not announced', () => {
    assistant.open('listening')
    assistant.status('listening', 'Listening')
    assistant.status('thinking', 'Thinking')
    assistant.status('step', 'Click Compose', { index: 1, total: 3 })
    assistant.status('error', 'No key')
    expect(say.mock.calls).toEqual([
      ['Thinking', { kind: 'phase' }],
      ['Click Compose', { kind: 'step' }],
      ['No key', { kind: 'error' }]
    ])
  })

  it('a failed query is announced once, not again by its "Error: …" status line', () => {
    assistant.open('thinking')
    bus.emit({ type: 'query.failed', turnId: 't1', error: 'network down' })
    assistant.status('error', 'Error: network down')
    expect(say).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('network down', { kind: 'error' })
  })

  it('marks the error row announced when a screen reader or TTS said it', () => {
    assistant.open('thinking')
    assistant.status('error', 'Microphone unavailable')
    expect(assistant.state().error?.announced).toBeUndefined()
    announced('Microphone unavailable', 'error', 'sr')
    expect(assistant.state().error?.announced).toBe(true)
    // No feedback line for it: the error row shows it.
    expect(assistant.state().live).toBeUndefined()
  })

  it('a confirm is announced assertively and survives the recording that answers it', async () => {
    const answer = assistant.requestConfirm({ summary: 'Click Send', risk: 'high' })
    expect(say).toHaveBeenCalledWith('Needs OK. Click Send. Say yes or stop.', {
      kind: 'confirm',
      priority: 'assertive'
    })
    assistant.open('listening')
    expect(assistant.state().confirm?.summary).toBe('Click Send')
    expect(assistant.confirmPending()).toBe(true)
    assistant.dropConfirm()
    expect(await answer).toBe(false)
    expect(assistant.confirmPending()).toBe(false)
  })

  it('shows what nobody voiced as a feedback line that clears after the status hold', () => {
    announced('Scrolled down', 'command')
    const live = assistant.state().live
    expect(live).toMatchObject({ text: 'Scrolled down', kind: 'command', audible: false })
    expect(assistant.state().visible).toBe(true)
    vi.advanceTimersByTime(loadConfig().a11y.timings.statusHoldMs + 10)
    expect(assistant.state().live).toBeUndefined()
    expect(assistant.state().visible).toBe(false)
  })

  it('does not show lines a screen reader or TTS said, unless captions are on', () => {
    announced('Opening Notepad', 'command', 'tts')
    expect(assistant.state().live).toBeUndefined()
    saveConfig({ ...loadConfig(), a11y: { ...loadConfig().a11y, captions: true } })
    announced('Opening Edge', 'command', 'sr')
    expect(assistant.state().live).toMatchObject({ text: 'Opening Edge', audible: true })
  })

  it('a line the screen reader declined becomes unspoken so the bar announces it', () => {
    saveConfig({ ...loadConfig(), a11y: { ...loadConfig().a11y, captions: true } })
    announced('Pressed Enter', 'command', 'sr')
    const id = assistant.state().live?.id
    announced('Pressed Enter', 'command', 'none')
    expect(assistant.state().live).toMatchObject({ id, audible: false })
  })

  it('skips scanning moves and phases, and marks a line equal to the status line as echo', () => {
    announced('Row 2', 'scan')
    announced('Thinking', 'phase')
    expect(assistant.state().live).toBeUndefined()
    assistant.status('answer', 'Scrolled down', undefined, 4000)
    announced('Scrolled down', 'command')
    expect(assistant.state().live?.echo).toBe(true)
  })

  it('captions what was heard until the next utterance', () => {
    assistant.open('listening')
    assistant.setCaption('scroll down')
    expect(assistant.state().caption).toBe('scroll down')
    vi.advanceTimersByTime(60_000)
    expect(assistant.state().caption).toBe('scroll down')
    assistant.open('listening')
    expect(assistant.state().caption).toBeUndefined()
  })

  it('captionHoldMs > 0 hides the caption after that long', () => {
    const cfg = loadConfig()
    saveConfig({
      ...cfg,
      a11y: { ...cfg.a11y, timings: { ...cfg.a11y.timings, captionHoldMs: 5000 } }
    })
    assistant.open('listening')
    assistant.setCaption('scroll down')
    vi.advanceTimersByTime(5001)
    expect(assistant.state().caption).toBeUndefined()
  })

  it('with captions on, the caption keeps the bar open after the turn', () => {
    saveConfig({ ...loadConfig(), a11y: { ...loadConfig().a11y, captions: true } })
    assistant.open('listening')
    assistant.setCaption('what time is it')
    assistant.turnEnded()
    expect(assistant.state().visible).toBe(true)
  })

  it('the caption editor survives a new recording and closes on cancel', () => {
    assistant.open('listening')
    assistant.setCaptionEdit({ mode: 'spell', draft: 'fi' })
    assistant.open('listening')
    expect(assistant.state().captionEdit).toEqual({ mode: 'spell', draft: 'fi' })
    assistant.turnEnded()
    expect(assistant.state().visible).toBe(true)
    assistant.setCaptionEdit(undefined)
    expect(assistant.state().visible).toBe(false)
  })

  it('Repeat goes through the announce policy as plain text when nothing speaks it', () => {
    assistant.showAnswer('**Compose** is at the [top left](https://x.test).')
    assistant.command({ type: 'repeat' })
    expect(say).toHaveBeenCalledWith('Compose is at the top left.', { kind: 'answer' })
  })

  it('opens the editor through the command deps', () => {
    const edit = vi.fn()
    assistant.setCommandDeps({ cancel: () => {}, edit })
    assistant.command({ type: 'edit' })
    assistant.command({ type: 'edit-cancel' })
    expect(edit.mock.calls).toEqual([[true], [false]])
    assistant.setCommandDeps({ cancel: () => {} })
  })
})
