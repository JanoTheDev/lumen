import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { PageReader, chunkText, speakMs, voiceStartPausesReading } from '../../src/main/a11y/reader'
import { A11yCommands, LOCAL_HANDLED } from '../../src/main/a11y/dispatch'
import { fakeA11yIo, type FakeA11yOptions } from '../helpers/fake-a11y-io'

const para = (n: number, words = 40): string =>
  Array.from({ length: words }, (_, i) => `word${n}x${i}`).join(' ') + '.'

describe('chunkText', () => {
  it('keeps paragraphs whole when they fit and joins short headings to the next', () => {
    const text = `Title\n\n${para(1)}\n\n${para(2)}`
    const parts = chunkText(text, 600)
    expect(parts).toHaveLength(2)
    expect(parts[0].startsWith('Title. word1x0')).toBe(true)
  })

  it('splits long paragraphs at sentence ends and never exceeds the limit', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const parts = chunkText(long, 120)
    expect(parts.length).toBeGreaterThan(5)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(120)
      expect(p.endsWith('.')).toBe(true)
    }
    expect(parts.join(' ')).toBe(long)
  })

  it('cuts a sentence with no stops at spaces', () => {
    const parts = chunkText('a'.repeat(50) + ' ' + 'b'.repeat(50) + ' ' + 'c'.repeat(50), 110)
    expect(parts.every((p) => p.length <= 110)).toBe(true)
    expect(parts.join(' ').replace(/\s+/g, '')).toBe(
      'a'.repeat(50) + 'b'.repeat(50) + 'c'.repeat(50)
    )
  })

  it('drops blank text', () => {
    expect(chunkText('  \n\n \n')).toEqual([])
  })

  it('estimates speaking time from words and rate', () => {
    expect(speakMs(para(1, 170))).toBeGreaterThan(60_000)
    expect(speakMs(para(1, 170), 2)).toBeLessThan(speakMs(para(1, 170)))
    expect(speakMs('Hi')).toBeGreaterThanOrEqual(1200)
  })
})

describe('PageReader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function reader(): { r: PageReader; spoken: string[]; silenced: () => number } {
    const spoken: string[] = []
    let silenced = 0
    const r = new PageReader({
      speak: (t) => spoken.push(t),
      silence: () => silenced++,
      rate: () => 1,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    return { r, spoken, silenced: () => silenced }
  }

  const page = [para(1), para(2), para(3)].join('\n\n')

  it('reads every part in order, then goes idle', () => {
    const { r, spoken } = reader()
    expect(r.start(page, 600)).toBe(true)
    expect(r.status).toBe('reading')
    vi.advanceTimersByTime(10 * 60_000)
    expect(spoken).toHaveLength(3)
    expect(r.status).toBe('idle')
  })

  it('pause silences and holds; continue re-reads the part that was cut', () => {
    const { r, spoken, silenced } = reader()
    r.start(page, 600)
    expect(r.pause()).toBe(true)
    expect(silenced()).toBe(1)
    vi.advanceTimersByTime(10 * 60_000)
    expect(spoken).toHaveLength(1)
    expect(r.resume()).toBe(true)
    expect(spoken).toEqual([spoken[0], spoken[0]])
  })

  it('next and back move between parts; next past the end stops', () => {
    const { r, spoken } = reader()
    r.start(page, 600)
    r.skip(1)
    r.skip(-1)
    expect(spoken.map((s) => s.slice(0, 7))).toEqual(['word1x0', 'word2x0', 'word1x0'])
    r.skip(1)
    r.skip(1)
    expect(r.skip(1)).toBe(false)
    expect(r.status).toBe('idle')
  })

  it('stop ends at once and nothing more is spoken', () => {
    const { r, spoken } = reader()
    r.start(page, 600)
    r.stop()
    vi.advanceTimersByTime(10 * 60_000)
    expect(spoken).toHaveLength(1)
    expect(r.active).toBe(false)
    expect(r.resume()).toBe(false)
  })
})

describe('describe and read commands (T13)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  async function run(
    utterances: string[],
    opts: FakeA11yOptions = {}
  ): Promise<ReturnType<typeof fakeA11yIo> & { a11y: A11yCommands }> {
    const f = fakeA11yIo(opts)
    const a11y = new A11yCommands(f.io)
    for (const u of utterances) {
      expect(a11y.tryHandle(u), u).toEqual({ response: LOCAL_HANDLED })
      await vi.advanceTimersByTimeAsync(0)
    }
    return { ...f, a11y }
  }

  it('"describe screen" says a brief description; "more detail" asks for the full one', async () => {
    const f = await run(['describe screen', 'more detail'])
    expect(f.calls.describes).toEqual(['brief', 'full'])
    expect(f.calls.said).toEqual(['A brief description.', 'A full description.'])
  })

  it('"more detail" without a description first is not a local command', () => {
    const f = fakeA11yIo()
    expect(new A11yCommands(f.io).tryHandle('more detail')).toBeNull()
  })

  it('"what\'s under my cursor" says the explanation', async () => {
    const f = await run(["what's under my cursor"])
    expect(f.calls.said).toEqual(['Send, a button.'])
  })

  it('"read this" reads the selection, else the focused field, else text under the pointer', async () => {
    let f = await run(['read this'], {
      text: { selection: { text: 'Hello there', source: 'selection' } }
    })
    expect(f.calls.said).toEqual(['Hello there'])
    expect(f.calls.textScopes).toEqual(['selection'])

    f = await run(['read this'], {
      text: {
        selection: { text: '', source: 'none' },
        focused: { text: 'Field text', source: 'value' }
      }
    })
    expect(f.calls.said).toEqual(['Field text'])

    f = await run(['read this'], {
      text: { focused: { text: 'OK', source: 'name' } },
      ocrText: { cursor: 'Seen by OCR' }
    })
    expect(f.calls.textScopes).toEqual(['selection', 'focused', 'point'])
    expect(f.calls.said).toEqual(['Seen by OCR'])
  })

  it('"read this" never reads a password field and says so when nothing is found', async () => {
    const f = await run(['read this'], { text: { selection: { text: '', source: 'password' } } })
    expect(f.calls.said).toEqual([])
    expect(f.calls.feedback.at(-1)).toEqual({
      text: 'I could not find text to read. Select some text first',
      ok: false
    })
  })

  it('"read the page" reads in parts that stop / pause / continue / next control', async () => {
    const doc = Array.from({ length: 6 }, (_, i) => para(i, 90)).join('\n\n')
    const f = await run(['read the page'], {
      text: { document: { text: doc, source: 'document' } }
    })
    expect(f.calls.parts).toHaveLength(1)
    expect(f.a11y.context().reading).toBe(true)

    f.a11y.tryHandle('pause')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(f.calls.parts).toHaveLength(1)
    f.a11y.tryHandle('continue')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.parts).toHaveLength(2)
    expect(f.calls.parts[1]).toBe(f.calls.parts[0])

    f.a11y.tryHandle('next')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.parts).toHaveLength(3)
    expect(f.calls.parts[2]).not.toBe(f.calls.parts[1])

    const silencedBefore = f.calls.silenced
    f.a11y.tryHandle('stop')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.silenced).toBeGreaterThan(silencedBefore)
    expect(f.a11y.context().reading).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(f.calls.parts).toHaveLength(3)
    // Not reading any more: "stop" is no longer the reader's.
    expect(f.a11y.tryHandle('stop')).toBeNull()
  })

  it('"read the page" falls back to OCR of the window', async () => {
    const f = await run(['read the page'], { ocrText: { window: para(1, 200) } })
    expect(f.calls.parts).toHaveLength(1)
  })

  it('with no voice the text is shown instead of read in parts', async () => {
    const f = await run(['read the page'], {
      canSpeak: false,
      text: { document: { text: para(1, 300), source: 'document' } }
    })
    expect(f.calls.parts).toEqual([])
    expect(f.calls.said).toHaveLength(1)
    expect(f.calls.feedback.at(-1)?.text).toMatch(/as text/)
  })

  it('Escape (reset) stops a reading', async () => {
    const f = await run(['read the page'], {
      text: { document: { text: para(1, 300) + '\n\n' + para(2, 300), source: 'document' } }
    })
    f.a11y.reset()
    expect(f.a11y.reader.active).toBe(false)
  })

  it('simple mode uses the plain phrases', async () => {
    const f = await run(['read this'], { simple: true })
    expect(f.calls.feedback.at(-1)?.text).toBe('Nothing to read. Select some text first')
  })
})

describe('voiceStartPausesReading (review a11y #2)', () => {
  it('a conversation re-listen does not pause the reading', () => {
    expect(voiceStartPausesReading({ handsFree: true }, true)).toBe(false)
  })
  it('the user starting to talk does', () => {
    expect(voiceStartPausesReading({ handsFree: false }, true)).toBe(true)
    expect(voiceStartPausesReading({ handsFree: true }, false)).toBe(true)
    expect(voiceStartPausesReading({ handsFree: false }, false)).toBe(true)
  })
})
