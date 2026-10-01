// API keys pasted in the app: encrypted with Windows DPAPI (safeStorage) in <configDir>/keys.dat,
// never in config.json. A key in .env wins; a vault key is copied into process.env so the
// provider clients (which read process.env and rebuild when it changes) pick it up.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { safeStorage } from 'electron'
import type { KeyProvider, KeySetResult, KeyStatus } from '@shared/channels'
import { bus } from '../bus'
import { configPath } from '../config'
import { log } from '../logger'

export const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai']
const ENV: Record<KeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY'
}

type Stored = Partial<Record<KeyProvider, string>>

let vault: Stored = {}
/** Providers whose key came from .env / the environment at startup. */
const fromEnv = new Set<KeyProvider>()

const vaultPath = (): string => join(dirname(configPath()), 'keys.dat')

function readVault(): Stored {
  const file = vaultPath()
  if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return {}
  try {
    const data = JSON.parse(safeStorage.decryptString(readFileSync(file))) as unknown
    if (!data || typeof data !== 'object') return {}
    const out: Stored = {}
    for (const p of KEY_PROVIDERS) {
      const v = (data as Record<string, unknown>)[p]
      if (typeof v === 'string' && v) out[p] = v
    }
    return out
  } catch (e) {
    log('fail', `key vault unreadable: ${(e as Error).message}`)
    return {}
  }
}

/** Returns false when encryption is unavailable (the vault then lives in memory only). */
function writeVault(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const file = vaultPath()
  try {
    if (!Object.keys(vault).length) {
      rmSync(file, { force: true })
      return true
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, safeStorage.encryptString(JSON.stringify(vault)))
    return true
  } catch (e) {
    log('fail', `key vault not saved: ${(e as Error).message}`)
    return false
  }
}

/** Call once after app ready (DPAPI needs it). Env keys are left alone. */
export function loadVault(): void {
  fromEnv.clear()
  for (const p of KEY_PROVIDERS) if (process.env[ENV[p]]) fromEnv.add(p)
  vault = readVault()
  for (const p of KEY_PROVIDERS) {
    const key = vault[p]
    if (key && !fromEnv.has(p)) process.env[ENV[p]] = key
  }
  const sources = keyStatus().map((k) => `${k.provider} ${k.set ? k.source : 'none'}`)
  log('step', `api keys: ${sources.join(', ')}`)
}

/** The key main should use for `provider` (.env first, then the vault), or undefined. */
export function getKey(provider: KeyProvider): string | undefined {
  return process.env[ENV[provider]] || undefined
}

export function hasKey(provider: KeyProvider): boolean {
  return !!getKey(provider)
}

export function keyStatus(): KeyStatus[] {
  return KEY_PROVIDERS.map((provider) => {
    const key = process.env[ENV[provider]]
    if (!key) return { provider, set: false }
    return {
      provider,
      set: true,
      source: fromEnv.has(provider) ? 'env' : 'vault',
      last4: key.slice(-4)
    }
  })
}

/** Stores a key the user pasted; it takes over from any .env key for this run. */
export function setKey(provider: KeyProvider, key: string): KeySetResult {
  vault[provider] = key
  process.env[ENV[provider]] = key
  fromEnv.delete(provider)
  const persisted = writeVault()
  bus.emit({ type: 'keys.changed', provider })
  return { ok: true, persisted }
}

export function clearKey(provider: KeyProvider): boolean {
  delete vault[provider]
  if (!fromEnv.has(provider)) delete process.env[ENV[provider]]
  const saved = writeVault()
  bus.emit({ type: 'keys.changed', provider })
  return saved
}

const TEST_URL: Record<KeyProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models?limit=1',
  openai: 'https://api.openai.com/v1/models'
}

/** A free, read-only call that only succeeds with a valid key. */
export async function testKey(
  provider: KeyProvider,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  const key = getKey(provider)
  if (!key) return { ok: false, error: 'No key yet.' }
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${key}` }
  try {
    const res = await fetchFn(TEST_URL[provider], { headers, signal: AbortSignal.timeout(8000) })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: 'That key was not accepted. Check it was copied in full.' }
    if (res.status === 429) return { ok: true }
    return { ok: false, error: `The service answered ${res.status}. Try again in a moment.` }
  } catch (e) {
    const name = (e as Error).name
    return {
      ok: false,
      error:
        name === 'TimeoutError' || name === 'AbortError'
          ? 'No answer within 8 seconds. Check your internet connection.'
          : 'Couldn’t reach the service. Check your internet connection.'
    }
  }
}
