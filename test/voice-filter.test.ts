import { describe, it, expect } from 'vitest'
import { computeRms, isSilenceHallucination, shouldDropTranscript } from '../src/renderer/src/hooks/useVoice'

describe('computeRms', () => {
  it('is 0 for silence and empty input', () => {
    expect(computeRms(new Float32Array(0))).toBe(0)
    expect(computeRms(new Float32Array(512))).toBe(0)
  })

  it('matches amplitude for a constant signal', () => {
    expect(computeRms(new Float32Array(256).fill(0.5))).toBeCloseTo(0.5)
  })

  it('is amplitude / sqrt(2) for a sine', () => {
    const d = new Float32Array(1024)
    for (let i = 0; i < d.length; i++) d[i] = 0.2 * Math.sin((2 * Math.PI * i * 8) / d.length)
    expect(computeRms(d)).toBeCloseTo(0.2 / Math.SQRT2, 3)
  })
})

describe('shouldDropTranscript', () => {
  it('drops empty text', () => {
    expect(shouldDropTranscript('', 2000)).toBe(true)
    expect(shouldDropTranscript('   ')).toBe(true)
  })

  it.each(['scroll down', 'go back', 'yes', 'stop', 'next'])('keeps short command "%s"', (t) => {
    expect(shouldDropTranscript(t, 50)).toBe(false)
    expect(shouldDropTranscript(t, 900)).toBe(false)
  })

  it.each(['Thank you.', 'thank you for watching', 'Thanks for watching.', 'you', 'Bye.'])('drops hallucination "%s" with little speech', (t) => {
    expect(isSilenceHallucination(t)).toBe(true)
    expect(shouldDropTranscript(t, 100)).toBe(true)
  })

  it('keeps hallucination-like text when real speech was heard', () => {
    expect(shouldDropTranscript('Thank you.', 800)).toBe(false)
  })

  it('keeps text without speech info (typed or replayed queries)', () => {
    expect(shouldDropTranscript('bye')).toBe(false)
  })
})
