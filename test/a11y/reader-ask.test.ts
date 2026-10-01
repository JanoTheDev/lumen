import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageReader, readerVoiceHooks } from '../../src/main/a11y/reader'
import { answerQuestion, askPending, askUser, onAskSettled } from '../../src/main/agent-mode/ask'

const para = (n: number): string =>
  Array.from({ length: 40 }, (_, i) => `word${n}x${i}`).join(' ') + '.'
const page = [para(1), para(2), para(3)].join('\n\n')

describe('page reader and an agent question re-listen', () => {
  let off: () => void
  let conversation = false
  let r: PageReader
  let hooks: ReturnType<typeof readerVoiceHooks>
  beforeEach(() => {
    vi.useFakeTimers()
    conversation = false
    r = new PageReader({
      speak: () => {},
      silence: () => {},
      rate: () => 1,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    hooks = readerVoiceHooks(r, { conversationActive: () => conversation, askPending })
    off = onAskSettled(() => hooks.askSettled())
  })
  afterEach(() => {
    off()
    vi.useRealTimers()
  })

  const io = { speak: () => {}, listen: () => hooks.voiceStarted({ handsFree: true }) }

  it('pauses for the question and reads on once it is answered', async () => {
    r.start(page, 600)
    const answer = askUser('Which folder?', io, new AbortController().signal)
    expect(r.status).toBe('paused')
    expect(answerQuestion('Downloads')).toBe(true)
    await expect(answer).resolves.toBe('Downloads')
    expect(r.status).toBe('reading')
  })

  it('reads on after an unanswered question times out', async () => {
    r.start(page, 600)
    const answer = askUser('Which folder?', io, new AbortController().signal, 1000)
    expect(r.status).toBe('paused')
    vi.advanceTimersByTime(1000)
    await expect(answer).resolves.toBeNull()
    expect(r.status).toBe('reading')
  })

  it('pauses even in conversation mode, since the mic would hear the reading', async () => {
    conversation = true
    r.start(page, 600)
    const answer = askUser('Which folder?', io, new AbortController().signal)
    expect(r.status).toBe('paused')
    answerQuestion('Downloads')
    await answer
    expect(r.status).toBe('reading')
  })

  it('stays paused when the user paused it by talking', async () => {
    r.start(page, 600)
    hooks.voiceStarted({ handsFree: false })
    expect(r.status).toBe('paused')
    const answer = askUser('Which folder?', io, new AbortController().signal)
    answerQuestion('Downloads')
    await answer
    expect(r.status).toBe('paused')
  })

  it('a request between question and answer ends the auto-resume', async () => {
    r.start(page, 600)
    const answer = askUser('Which folder?', io, new AbortController().signal)
    hooks.queryStarted()
    r.stop()
    answerQuestion('Downloads')
    await answer
    expect(r.status).toBe('idle')
  })
})
