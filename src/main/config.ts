import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from './logger'
import {
  configV2Schema,
  DEFAULT_CONFIG_V2,
  migrateV1toV2,
  withV2Defaults,
  type ConfigV2,
  type ConfigPatch
} from '@shared/config'

export type ThemeName = ConfigV2['theme']
export type ThemeCustom = NonNullable<ConfigV2['themeCustom']>
export type AppConfig = ConfigV2

export const DEFAULT_CONFIG: AppConfig = DEFAULT_CONFIG_V2

let configDir: string | null = null
let cached: AppConfig | null = null
let warning: string | null = null
// True while the file on disk is still v1 and has not been backed up yet.
let pendingV1Backup = false

const clone = (c: AppConfig): AppConfig => structuredClone(c)

function dir(): string {
  return configDir ?? join(homedir(), '.ai-overlay')
}

/** Overrides the config directory (tests). Pass null to restore ~/.ai-overlay. Clears the cache. */
export function setConfigDir(path: string | null): void {
  configDir = path
  invalidateConfig()
}

export function configPath(): string {
  return join(dir(), 'config.json')
}

export function backupPath(): string {
  return join(dir(), 'config.v1.bak.json')
}

/** Warning from the last load (migration repair or invalid file), or null. */
export function lastConfigWarning(): string | null {
  return warning
}

/** Drops the in-memory cache so the next loadConfig() rereads the file. */
export function invalidateConfig(): void {
  cached = null
  warning = null
  pendingV1Backup = false
}

function backupInvalid(raw: string): string {
  const file = join(dir(), `config.invalid.${Date.now()}.json`)
  try {
    writeFileSync(file, raw, 'utf8')
  } catch (e) {
    log('fail', `config backup failed: ${(e as Error).message}`)
  }
  return file
}

function useDefaults(msg: string): AppConfig {
  warning = msg
  log('fail', msg)
  cached = clone(DEFAULT_CONFIG)
  return cached
}

export function loadConfig(): AppConfig {
  if (cached) return cached
  warning = null
  pendingV1Backup = false
  const path = configPath()
  if (!existsSync(path)) {
    cached = clone(DEFAULT_CONFIG)
    return cached
  }
  let raw = ''
  let parsed: unknown
  try {
    raw = readFileSync(path, 'utf8')
    parsed = JSON.parse(raw)
  } catch (e) {
    const bad = raw ? backupInvalid(raw) : ''
    return useDefaults(`config unreadable (${(e as Error).message}), using defaults${bad ? `; saved copy at ${bad}` : ''}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const bad = backupInvalid(raw)
    return useDefaults(`config is not an object, using defaults; saved copy at ${bad}`)
  }

  const obj = parsed as Record<string, unknown>
  const isV2 = obj.version === 2
  if (!isV2) pendingV1Backup = true
  let candidate = withV2Defaults(isV2 ? obj : migrateV1toV2(obj))
  let result = configV2Schema.safeParse(candidate)
  if (!result.success) {
    const bad = backupInvalid(raw)
    const keys = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean)
    candidate = { ...candidate }
    for (const k of keys) candidate[k] = structuredClone((DEFAULT_CONFIG as Record<string, unknown>)[k])
    result = configV2Schema.safeParse(candidate)
    if (!result.success) return useDefaults(`config invalid, using defaults; saved copy at ${bad}`)
    warning = `config had invalid values for ${keys.join(', ')}; reset to defaults (saved copy at ${bad})`
    log('fail', warning)
  }
  cached = result.data
  return cached
}

/** Merges a patch one level deep into the current config, validates, and writes it. Throws on invalid result. */
export function saveConfig(update: ConfigPatch | Partial<AppConfig>): AppConfig {
  const current = loadConfig()
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue
    const prev = next[key]
    next[key] =
      value && typeof value === 'object' && !Array.isArray(value) && prev && typeof prev === 'object'
        ? { ...prev, ...value }
        : value
  }
  const merged = configV2Schema.parse(withV2Defaults(next))
  if (!existsSync(dir())) mkdirSync(dir(), { recursive: true })
  const path = configPath()
  if (pendingV1Backup && existsSync(path) && !existsSync(backupPath())) {
    copyFileSync(path, backupPath())
    log('done', `v1 config backed up to ${backupPath()}`)
  }
  pendingV1Backup = false
  writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8')
  cached = merged
  log('done', `config saved to ${path}`)
  return merged
}

export function resetConfig(): AppConfig {
  cached = clone(DEFAULT_CONFIG)
  return cached
}
