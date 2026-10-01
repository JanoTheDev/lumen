import { describe, expect, it } from 'vitest'
import { isWav, parseWav } from '../../src/main/speech/stt/wav'
import { encodeWav } from '../../src/renderer/src/voice/wav'

describe('wav round trip', () => {
  it('parses what the renderer encodes', () => {
    const n = 1600
    const tone = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000))
    const buf = encodeWav(tone, 16000)
    expect(isWav(buf)).toBe(true)
    expect(buf.byteLength).toBe(44 + n * 2)
    const pcm = parseWav(buf)
    expect(pcm?.sampleRate).toBe(16000)
    expect(pcm?.samples.length).toBe(n)
    for (let i = 0; i < n; i += 97) expect(pcm!.samples[i]).toBeCloseTo(tone[i], 3)
  })

  it('clips out-of-range samples', () => {
    const pcm = parseWav(encodeWav(new Float32Array([2, -2]), 16000))
    expect(pcm!.samples[0]).toBeCloseTo(1, 3)
    expect(pcm!.samples[1]).toBe(-1)
  })

  it('mixes stereo down to mono', () => {
    const buf = new ArrayBuffer(44 + 8)
    const v = new DataView(buf)
    const ascii = (at: number, s: string): void =>
      [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
    ascii(0, 'RIFF')
    v.setUint32(4, 44, true)
    ascii(8, 'WAVE')
    ascii(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 2, true)
    v.setUint32(24, 16000, true)
    v.setUint16(34, 16, true)
    ascii(36, 'data')
    v.setUint32(40, 8, true)
    v.setInt16(44, 16384, true)
    v.setInt16(46, 0, true)
    v.setInt16(48, -16384, true)
    v.setInt16(50, -16384, true)
    const pcm = parseWav(buf)
    expect(Array.from(pcm!.samples)).toEqual([0.25, -0.5])
  })

  it('rejects non-wav and non-pcm input', () => {
    expect(parseWav(new ArrayBuffer(10))).toBeNull()
    expect(isWav(new TextEncoder().encode('webm-data-not-a-wav').buffer)).toBe(false)
  })
})
