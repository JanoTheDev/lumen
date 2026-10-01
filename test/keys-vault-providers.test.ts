import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())

import { invokeHandler, resetElectronMock } from './helpers/electron-mock'
import { tempDir } from './helpers/fixtures'
import { invalidateConfig, saveConfig, setConfigDir } from '../src/main/config'
import { keyStatus, loadVault, setLocalOnly, testKey } from '../src/main/keys/vault'
import { registerKeysIpc } from '../src/main/keys/ipc'

// Built from pieces so no committed literal looks like a real key to secret scanners.
const GEMINI = ['AI', 'za', 'Test', 'x'.repeat(31)].join('')
const OTHER = ['gsk', 'test', 'y'.repeat(30)].join('_')
const ANTHROPIC = ['sk', 'ant', 'test', '0123456789abcdefWXYZ'].join('-')

const VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'COMPATIBLE_API_KEY']

describe('key vault: Gemini, compatible services, Local only', () => {
  let tmp: ReturnType<typeof tempDir>
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const v of VARS) {
      saved[v] = process.env[v]
      delete process.env[v]
    }
    tmp = tempDir()
    setConfigDir(tmp.dir)
    invalidateConfig()
    resetElectronMock()
    loadVault()
    registerKeysIpc()
  })
  afterEach(() => {
    setLocalOnly(false)
    tmp.cleanup()
    vi.restoreAllMocks()
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
    }
  })

  it('stores Gemini and compatible keys like the others', async () => {
    expect(await invokeHandler('keys:set', { provider: 'gemini', key: GEMINI })).toMatchObject({
      ok: true
    })
    await invokeHandler('keys:set', { provider: 'compatible', key: OTHER })
    expect(process.env.GEMINI_API_KEY).toBe(GEMINI)
    expect(process.env.COMPATIBLE_API_KEY).toBe(OTHER)
    const status = keyStatus()
    expect(status.find((s) => s.provider === 'gemini')).toMatchObject({
      set: true,
      source: 'vault'
    })
    expect(JSON.stringify(status)).not.toContain(GEMINI)
  })

  it('Local only takes every cloud key out of the environment and brings it back', async () => {
    await invokeHandler('keys:set', { provider: 'anthropic', key: ANTHROPIC })
    await invokeHandler('keys:set', { provider: 'gemini', key: GEMINI })
    setLocalOnly(true)
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
    expect(keyStatus().find((s) => s.provider === 'gemini')).toMatchObject({
      set: true,
      paused: true
    })
    // A key pasted meanwhile is kept but stays aside too.
    await invokeHandler('keys:set', {
      provider: 'openai',
      key: ['sk', 'proj', 'z'.repeat(30)].join('-')
    })
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    setLocalOnly(false)
    expect(process.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC)
    expect(process.env.GEMINI_API_KEY).toBe(GEMINI)
    expect(process.env.OPENAI_API_KEY).toBeDefined()
  })

  it('Local only in the config applies at startup', async () => {
    await invokeHandler('keys:set', { provider: 'anthropic', key: ANTHROPIC })
    saveConfig({ models: { localOnly: true } })
    loadVault()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('tests a Gemini key on its OpenAI-compatible models list; 400 means a bad key', async () => {
    await invokeHandler('keys:set', { provider: 'gemini', key: GEMINI })
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await testKey('gemini', ok)).toEqual({ ok: true })
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${GEMINI}`)
    const bad = vi.fn(async () => new Response('{}', { status: 400 }))
    expect((await testKey('gemini', bad)).ok).toBe(false)
  })

  it('tests a compatible key on the preset address, and asks for an address first', async () => {
    await invokeHandler('keys:set', { provider: 'compatible', key: OTHER })
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    expect((await testKey('compatible', ok)).error).toMatch(/address/)
    saveConfig({ models: { compatible: { preset: 'groq' } } })
    expect(await testKey('compatible', ok)).toEqual({ ok: true })
    expect((ok.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.groq.com/openai/v1/models'
    )
  })
})
