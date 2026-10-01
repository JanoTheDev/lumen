// API keys pasted in the app: encrypted with Windows DPAPI (safeStorage) in <configDir>/keys.dat,
// never in config.json. A key in .env wins at startup; a pasted key takes over for the run. The
// key in effect is copied into process.env so the provider clients (which read process.env and
// rebuild when it changes) pick it up. "Local only" (models.localOnly) takes every cloud key out
// of process.env until it is turned off, so nothing (models, cloud speech, paid search) can
// reach a cloud AI meanwhile.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { safeStorage } from 'electron'
import type { KeyProvider, KeySetResult, KeyStatus } from '@shared/channels'
import { bus } from '../bus'
import { configPath, loadConfig } from '../config'
import { log } from '../logger'
import { compatibleSettings, COMPATIBLE_ENV } from '../ai/providers/compatible'
import { GEMINI_BASE_URL, GEMINI_ENV } from '../ai/providers/gemini'

export const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'gemini', 'compatible']
const ENV: Record<KeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: GEMINI_ENV,
  compatible: COMPATIBLE_ENV
}

type Stored = Partial<Record<KeyProvider, string>>

/** Pasted keys, as saved in keys.dat. */
let vault: Stored = {}
/** Keys that came from .env / the environment at startup; restored when a pasted key is cleared. */
let envKeys: Stored = {}
/** The key in effect per provider (what process.env holds unless Local only is on). */
let active: Stored = {}
/** Local only is in effect: process.env holds no cloud key. */
let paused = false

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

/** process.env mirrors the keys in effect, or holds none while Local only is on. */
function syncEnv(): void {
  for (const p of KEY_PROVIDERS) {
    const key = paused ? undefined : active[p]
    if (key) process.env[ENV[p]] = key
    else delete process.env[ENV[p]]
  }
}

/** Call once after app ready (DPAPI needs it). Env keys win over vault keys. */
export function loadVault(): void {
  envKeys = {}
  for (const p of KEY_PROVIDERS) if (process.env[ENV[p]]) envKeys[p] = process.env[ENV[p]]
  vault = readVault()
  active = { ...vault, ...envKeys }
  paused = loadConfig().models.localOnly === true
  syncEnv()
  const sources = keyStatus().map((k) => `${k.provider} ${k.set ? k.source : 'none'}`)
  log('step', `api keys: ${sources.join(', ')}${paused ? ' (local only: set aside)' : ''}`)
}

/** Local only on: every cloud key leaves process.env; off: they come back. */
export function setLocalOnly(on: boolean): void {
  if (paused === on) return
  paused = on
  syncEnv()
  log('step', on ? 'local only: cloud keys set aside' : 'local only off: cloud keys back')
  for (const provider of KEY_PROVIDERS) bus.emit({ type: 'keys.changed', provider })
}

/** The key main should use for `provider` (none while Local only is on), or undefined. */
export function getKey(provider: KeyProvider): string | undefined {
  return process.env[ENV[provider]] || undefined
}

export function hasKey(provider: KeyProvider): boolean {
  return !!getKey(provider)
}

export function keyStatus(): KeyStatus[] {
  return KEY_PROVIDERS.map((provider) => {
    const key = active[provider]
    if (!key) return { provider, set: false }
    return {
      provider,
      set: true,
      source: key === envKeys[provider] ? 'env' : 'vault',
      last4: key.slice(-4),
      ...(paused ? { paused: true } : {})
    }
  })
}

/** Stores a key the user pasted; it takes over from any .env key for this run. */
export function setKey(provider: KeyProvider, key: string): KeySetResult {
  vault[provider] = key
  active[provider] = key
  syncEnv()
  const persisted = writeVault()
  bus.emit({ type: 'keys.changed', provider })
  return { ok: true, persisted }
}

export function clearKey(provider: KeyProvider): boolean {
  delete vault[provider]
  // A .env key the pasted one had replaced applies again.
  if (envKeys[provider]) active[provider] = envKeys[provider]
  else delete active[provider]
  syncEnv()
  const saved = writeVault()
  bus.emit({ type: 'keys.changed', provider })
  return saved
}

/** A free, read-only URL that only answers 200 with a valid key, or null (no address yet). */
function testUrl(provider: KeyProvider): string | null {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/models?limit=1'
  if (provider === 'openai') return 'https://api.openai.com/v1/models'
  if (provider === 'gemini') return `${GEMINI_BASE_URL}models`
  const base = compatibleSettings()?.baseUrl
  return base ? `${base}/models` : null
}

/** A free, read-only call that only succeeds with a valid key. */
export async function testKey(
  provider: KeyProvider,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  // Checked even while Local only sets keys aside: the check is the user's own request.
  const key = active[provider] ?? getKey(provider)
  if (!key) return { ok: false, error: 'No key yet.' }
  const url = testUrl(provider)
  if (!url) return { ok: false, error: 'Pick a service or enter its address first.' }
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${key}` }
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(8000) })
    if (res.ok) return { ok: true }
    // Google answers a bad key with 400 API_KEY_INVALID.
    if (res.status === 401 || res.status === 403 || (provider === 'gemini' && res.status === 400))
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
