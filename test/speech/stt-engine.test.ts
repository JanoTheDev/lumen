import { describe, expect, it } from 'vitest'
import { chooseStt, wantsLocalModel, type SttAvailability } from '../../src/main/speech/stt/engine'

const avail = (o: Partial<SttAvailability> = {}): SttAvailability => ({
  openaiKey: false,
  localSupported: true,
  localInstalled: true,
  ...o
})

describe('chooseStt', () => {
  it('uses local by default, even with an OpenAI key', () => {
    expect(chooseStt('local', avail({ openaiKey: true }))).toEqual({ engine: 'local' })
  })
  it('uses cloud when the user prefers it and has a key', () => {
    expect(chooseStt('cloud-batch', avail({ openaiKey: true }))).toEqual({ engine: 'cloud' })
    expect(chooseStt('cloud-stream', avail({ openaiKey: true }))).toEqual({ engine: 'cloud' })
  })
  it('falls back to local when cloud is preferred but there is no key', () => {
    expect(chooseStt('cloud-batch', avail())).toEqual({ engine: 'local' })
  })
  it('bridges with cloud while the local model downloads', () => {
    expect(chooseStt('local', avail({ openaiKey: true, localInstalled: false }))).toEqual({
      engine: 'cloud'
    })
  })
  it('reports installing for an Anthropic-only user without the model yet', () => {
    expect(chooseStt('local', avail({ localInstalled: false }))).toEqual({
      engine: null,
      reason: 'installing'
    })
  })
  it('reports no engine when the native engine cannot load and there is no key', () => {
    expect(chooseStt('local', avail({ localSupported: false }))).toEqual({
      engine: null,
      reason: 'no-engine'
    })
  })
})

describe('wantsLocalModel', () => {
  it('downloads when local is preferred or there is no OpenAI key', () => {
    expect(wantsLocalModel('local', avail({ localInstalled: false, openaiKey: true }))).toBe(true)
    expect(wantsLocalModel('cloud-batch', avail({ localInstalled: false }))).toBe(true)
  })
  it('does not download for a cloud user with a key, or when already installed', () => {
    expect(wantsLocalModel('cloud-batch', avail({ localInstalled: false, openaiKey: true }))).toBe(
      false
    )
    expect(wantsLocalModel('local', avail())).toBe(false)
  })
  it('does not download when the engine cannot run here', () => {
    expect(wantsLocalModel('local', avail({ localInstalled: false, localSupported: false }))).toBe(
      false
    )
  })
})

describe('voice language without an offline model', () => {
  it('uses cloud with a key, else reports the language', () => {
    const it_ = { localLanguage: false }
    expect(chooseStt('local', avail({ ...it_, openaiKey: true }))).toEqual({ engine: 'cloud' })
    expect(chooseStt('local', avail(it_))).toEqual({ engine: null, reason: 'language' })
    expect(wantsLocalModel('local', avail({ ...it_, localInstalled: false }))).toBe(false)
  })
})
