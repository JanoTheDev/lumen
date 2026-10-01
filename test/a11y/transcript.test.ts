import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../../src/main/windows/ui-mode', () => ({ uiV2: () => true }))
const patchConfig = vi.fn<(p: unknown) => Promise<unknown>>(async () => ({}))
vi.mock('../../src/main/ipc/settings', () => ({ patchConfig: (p: unknown) => patchConfig(p) }))
const hudSend = vi.fn()
vi.mock('../../src/main/windows/hud', () => ({ send: (...a: unknown[]) => hudSend(...a) }))

import { loadConfig, saveConfig, setConfigDir } from '../../src/main/config'
import * as assistant from '../../src/main/windows/assistant'
import {
  beforeUtterance,
  confirmActions,
  explainBeforeDo,
  openEditor,
  submitEdit
} from '../../src/main/a11y/transcript'
import { LOCAL_HANDLED } from '../../src/main/a11y/dispatch'
import { tempDir } from '../helpers/fixtures'

function setPolicy(confirmTranscript: 'always' | 'risky' | 'off'): void {
  saveConfig({ ...loadConfig(), a11y: { ...loadConfig().a11y, confirmTranscript } })
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('transcript confirmation and corrections (06 T14)', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    patchConfig.mockClear()
    hudSend.mockClear()
    assistant.setCommandDeps({ cancel: () => {}, edit: openEditor })
  })
  afterEach(() => {
    assistant.close()
    assistant.consumeDenied()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('captions every utterance before it runs', () => {
    assistant.open('listening')
    expect(beforeUtterance('scroll down')).toEqual({ prompt: 'scroll down' })
    expect(assistant.state().caption).toBe('scroll down')
  })

  it('"yes" answers a waiting confirm and goes no further', async () => {
    const answer = assistant.requestConfirm({ summary: 'Click Send', risk: 'high' })
    assistant.open('listening')
    expect(beforeUtterance('Yes.')).toEqual({ handled: LOCAL_HANDLED })
    expect(await answer).toBe(true)
  })

  it('a new request while a confirm waits says no to it and runs', async () => {
    const answer = assistant.requestConfirm({ summary: 'Click Send', risk: 'high' })
    expect(beforeUtterance('what time is it')).toEqual({ prompt: 'what time is it' })
    expect(await answer).toBe(false)
  })

  it('"no, I said …" re-runs the corrected words and learns a word corrected twice', () => {
    beforeUtterance('open spotty fly')
    expect(beforeUtterance('no, I said open Spotify')).toEqual({ prompt: 'open Spotify' })
    expect(assistant.state().caption).toBe('open Spotify')
    expect(patchConfig).not.toHaveBeenCalled()
    beforeUtterance('play spot if I')
    beforeUtterance('no I said play Spotify')
    expect(patchConfig).toHaveBeenCalledWith({ voiceVocab: 'Spotify' })
  })

  it('"correct that" opens the editor; Enter runs the edited text', () => {
    beforeUtterance('open spotty fly')
    expect(beforeUtterance('correct that')).toEqual({ handled: LOCAL_HANDLED })
    expect(assistant.state().captionEdit).toEqual({ mode: 'edit', draft: 'open spotty fly' })
    submitEdit('open Spotify')
    expect(assistant.state().captionEdit).toBeUndefined()
    expect(hudSend).toHaveBeenCalledWith('assistant:run-query', 'open Spotify')
  })

  it('"spell that" collects letters by voice, "done" runs them', () => {
    beforeUtterance('search frigma')
    beforeUtterance('spell that')
    expect(beforeUtterance('f i g m a')).toEqual({ handled: LOCAL_HANDLED })
    expect(assistant.state().captionEdit).toEqual({ mode: 'spell', draft: 'figma' })
    expect(beforeUtterance('done')).toEqual({ prompt: 'figma' })
    expect(assistant.state().captionEdit).toBeUndefined()
  })

  it('the Edit button and Escape open and close the editor', () => {
    beforeUtterance('open spotty fly')
    assistant.command({ type: 'edit' })
    expect(assistant.state().captionEdit?.draft).toBe('open spotty fly')
    assistant.command({ type: 'edit-cancel' })
    expect(assistant.state().captionEdit).toBeUndefined()
  })

  it('risky (default): only a batch that sends waits for yes', async () => {
    beforeUtterance('reply see you')
    expect(await confirmActions([{ type: 'type', text: 'see you' }])).toBe(true)
    const pending = confirmActions([
      { type: 'type', text: 'see you' },
      { type: 'hotkey', keys: ['enter'] }
    ])
    await flush()
    expect(assistant.state().confirm?.summary).toBe(
      'I heard “reply see you”. I’ll type “see you”, then press Enter'
    )
    expect(assistant.state().confirm?.countdownMs).toBeUndefined()
    assistant.command({ type: 'deny' })
    expect(await pending).toBe(false)
  })

  it('always: every batch waits, one yes covers the rest of the utterance', async () => {
    setPolicy('always')
    beforeUtterance('scroll down')
    const first = confirmActions([{ type: 'scroll' }])
    await flush()
    expect(assistant.state().confirm?.risk).toBe('low')
    assistant.command({ type: 'confirm' })
    expect(await first).toBe(true)
    expect(await confirmActions([{ type: 'scroll' }])).toBe(true)
    // The next utterance asks again.
    beforeUtterance('scroll up')
    const next = confirmActions([{ type: 'scroll' }])
    await flush()
    expect(assistant.confirmPending()).toBe(true)
    assistant.command({ type: 'confirm' })
    await next
  })

  it('always: explain-before-do waits (no countdown) and its yes covers the batch', async () => {
    setPolicy('always')
    beforeUtterance('click compose')
    const p = explainBeforeDo('Click Compose', 'low', 2000)
    await flush()
    expect(assistant.state().confirm).toMatchObject({
      summary: 'I heard “click compose”. Click Compose',
      countdownMs: undefined
    })
    assistant.command({ type: 'confirm' })
    expect(await p).toBe(true)
    expect(await confirmActions([{ type: 'click_element', text: 'Compose' }])).toBe(true)
  })

  it('off: never asks', async () => {
    setPolicy('off')
    beforeUtterance('send it')
    expect(await confirmActions([{ type: 'hotkey', keys: ['enter'] }])).toBe(true)
  })
})
