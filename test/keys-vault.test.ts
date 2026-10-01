import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())

import { existsSync } from 'fs'
import { join } from 'path'
import { electronMock, invokeHandler, resetElectronMock } from './helpers/electron-mock'
import { tempDir } from './helpers/fixtures'
import { invalidateConfig, setConfigDir } from '../src/main/config'
import { bus } from '../src/main/bus'
import { getKey, hasKey, loadVault, keyStatus, testKey } from '../src/main/keys/vault'
import { registerKeysIpc } from '../src/main/keys/ipc'

// Built from pieces so no committed literal looks like a real key to secret scanners.
const KEY = ['sk', 'ant', 'test', '0123456789abcdefWXYZ'].join('-')

describe('key vault', () => {
  let tmp: ReturnType<typeof tempDir>
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    tmp = tempDir()
    setConfigDir(tmp.dir)
    invalidateConfig()
    resetElectronMock()
    loadVault()
    registerKeysIpc()
  })
  afterEach(() => {
    tmp.cleanup()
    vi.restoreAllMocks()
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved.a
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.o
  })

  it('stores an encrypted key outside config.json and reports only the last 4', async () => {
    const res = await invokeHandler('keys:set', { provider: 'anthropic', key: ` ${KEY} ` })
    expect(res).toEqual({ ok: true, persisted: true })
    expect(process.env.ANTHROPIC_API_KEY).toBe(KEY)
    expect(electronMock.safeStorage.encryptString).toHaveBeenCalled()
    expect(existsSync(join(tmp.dir, 'keys.dat'))).toBe(true)
    expect(existsSync(join(tmp.dir, 'config.json'))).toBe(false)
    const status = (await invokeHandler('keys:status')) as unknown[]
    expect(status).toContainEqual({
      provider: 'anthropic',
      set: true,
      source: 'vault',
      last4: 'WXYZ'
    })
    expect(JSON.stringify(status)).not.toContain(KEY)
  })

  it('loads the vault into the environment on start, env keys first', async () => {
    await invokeHandler('keys:set', { provider: 'openai', key: KEY })
    delete process.env.OPENAI_API_KEY
    loadVault()
    expect(process.env.OPENAI_API_KEY).toBe(KEY)

    process.env.OPENAI_API_KEY = 'from-env-key-123456789012'
    loadVault()
    expect(process.env.OPENAI_API_KEY).toBe('from-env-key-123456789012')
    expect(keyStatus().find((s) => s.provider === 'openai')?.source).toBe('env')
  })

  it('clears a key and removes the file when empty', async () => {
    await invokeHandler('keys:set', { provider: 'anthropic', key: KEY })
    await invokeHandler('keys:clear', 'anthropic')
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(existsSync(join(tmp.dir, 'keys.dat'))).toBe(false)
  })

  it('clearing a pasted key restores the .env key it replaced', async () => {
    process.env.OPENAI_API_KEY = 'from-env-key-123456789012'
    loadVault()
    await invokeHandler('keys:set', { provider: 'openai', key: KEY })
    expect(keyStatus().find((s) => s.provider === 'openai')?.source).toBe('vault')
    await invokeHandler('keys:clear', 'openai')
    expect(process.env.OPENAI_API_KEY).toBe('from-env-key-123456789012')
    expect(keyStatus().find((s) => s.provider === 'openai')?.source).toBe('env')
  })

  it('keeps the key in memory when encryption is unavailable', async () => {
    electronMock.safeStorage.isEncryptionAvailable.mockReturnValueOnce(false)
    const res = await invokeHandler('keys:set', { provider: 'anthropic', key: KEY })
    expect(res).toEqual({ ok: true, persisted: false })
    expect(process.env.ANTHROPIC_API_KEY).toBe(KEY)
  })

  it('rejects junk', async () => {
    const res = (await invokeHandler('keys:set', { provider: 'anthropic', key: 'short' })) as {
      ok: boolean
    }
    expect(res.ok).toBe(false)
    expect(existsSync(join(tmp.dir, 'keys.dat'))).toBe(false)
  })

  it('tests a key with a read-only request', async () => {
    process.env.ANTHROPIC_API_KEY = KEY
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }))
    await expect(testKey('anthropic', fetchFn)).resolves.toEqual({ ok: true })
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY)
    const bad = vi.fn(async () => new Response('{}', { status: 401 }))
    expect((await testKey('anthropic', bad)).ok).toBe(false)
    expect((await testKey('openai', fetchFn)).ok).toBe(false)
  })

  it('exposes the active key to main and announces changes', async () => {
    const changed: string[] = []
    const off = bus.on('keys.changed', (e) => changed.push(e.provider))
    expect(hasKey('anthropic')).toBe(false)
    await invokeHandler('keys:set', { provider: 'anthropic', key: KEY })
    expect(getKey('anthropic')).toBe(KEY)
    expect(hasKey('anthropic')).toBe(true)
    await invokeHandler('keys:clear', 'anthropic')
    expect(getKey('anthropic')).toBeUndefined()
    off()
    expect(changed).toEqual(['anthropic', 'anthropic'])
  })
})
