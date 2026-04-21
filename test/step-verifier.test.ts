import { describe, it, expect } from 'vitest'
import { hashScreenshot, shouldVerifyStep } from '../src/main/step-verifier'

describe('step-verifier', () => {
  it('hashes the same base64 string consistently', () => {
    const b64 = Buffer.from('fake screenshot data').toString('base64')
    expect(hashScreenshot(b64)).toBe(hashScreenshot(b64))
  })

  it('returns different hashes for different screenshots', () => {
    const a = Buffer.from('screenshot A').toString('base64')
    const b = Buffer.from('screenshot B').toString('base64')
    expect(hashScreenshot(a)).not.toBe(hashScreenshot(b))
  })

  it('excludes navigate_url from verification (verifier misjudges slow loads)', () => {
    expect(shouldVerifyStep('navigate_url')).toBe(false)
  })

  it('excludes open_url from verification', () => {
    expect(shouldVerifyStep('open_url')).toBe(false)
  })

  it('marks type as requiring verification', () => {
    expect(shouldVerifyStep('type')).toBe(true)
  })

  it('marks move as not requiring verification', () => {
    expect(shouldVerifyStep('move')).toBe(false)
  })

  it('marks scroll as not requiring verification', () => {
    expect(shouldVerifyStep('scroll')).toBe(false)
  })
})
