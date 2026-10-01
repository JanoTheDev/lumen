import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TtsMessage } from '@shared/channels'

type Handler = (msg: TtsMessage) => void

let handler: Handler | null = null
let voicesListener: (() => void) | null = null
const speak = vi.fn()

beforeEach(() => {
  vi.resetModules()
  handler = null
  voicesListener = null
  speak.mockReset()
  vi.stubGlobal('window', {
    lumen: {
      on: (_channel: string, cb: Handler) => {
        handler = cb
        return () => {}
      }
    }
  })
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => (voicesListener === null ? [] : [{ name: 'A', lang: 'en-US' }]),
    addEventListener: (_e: string, cb: () => void) => {
      voicesListener = cb
    },
    removeEventListener: () => {},
    speak,
    cancel: () => {}
  })
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const say: TtsMessage = { op: 'say', turnId: 't1', seq: 0, text: 'hello', voice: 'A', rate: 1 }

describe('speaker sayWindows', () => {
  it('speaks once the voice list loads', async () => {
    const { startSpeaker } = await import('../../src/renderer/src/voice/speaker')
    startSpeaker()
    handler?.(say)
    voicesListener?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('drops a say when stop arrives while the voices are loading', async () => {
    const { startSpeaker } = await import('../../src/renderer/src/voice/speaker')
    startSpeaker()
    handler?.(say)
    handler?.({ op: 'stop' })
    voicesListener?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(speak).not.toHaveBeenCalled()
  })
})
