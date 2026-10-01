// Runs only where the offline model has been downloaded (~/.ai-overlay/stt-model).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { localSttReady, transcribeLocal } from '../../src/main/speech/stt/local'
import { parseWav } from '../../src/main/speech/stt/wav'

const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(join(__dirname, '../fixtures/audio', name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim()

describe.skipIf(!localSttReady())('local stt', () => {
  it('transcribes short commands', { timeout: 30_000 }, async () => {
    const short = parseWav(fixture('scroll-down.wav'))!
    expect(words(await transcribeLocal(short.samples, short.sampleRate))).toBe('scroll down')
    const long = parseWav(fixture('open-gmail-drafts.wav'))!
    expect(words(await transcribeLocal(long.samples, long.sampleRate))).toBe(
      'open gmail and show me my drafts'
    )
  })
})
