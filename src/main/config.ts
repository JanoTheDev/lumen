import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { log } from './logger'

export type ThemeName = 'dark' | 'light' | 'high-contrast' | 'ocean' | 'forest' | 'sunset' | 'midnight' | 'custom'

export interface ThemeCustom {
  accent: string
  background: string
  foreground: string
  opacity: number
  blur: number
}

export interface AppConfig {
  version: 1
  theme: ThemeName
  themeCustom?: ThemeCustom
  models: {
    planning?: string
    execution?: string
    verification?: string
  }
  hotkey: string
  hudAutoCloseMs: number
  answerAutoCloseMs: number
  wakeWord: {
    enabled: boolean
    phrase: string
  }
  historyEnabled: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  theme: 'dark',
  models: {},
  hotkey: 'Ctrl+Shift+Space',
  hudAutoCloseMs: 5000,
  answerAutoCloseMs: 10000,
  wakeWord: { enabled: false, phrase: 'hey lumen' },
  historyEnabled: true,
}

const CONFIG_DIR = join(homedir(), '.ai-overlay')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

let cached: AppConfig | null = null

export function configPath(): string {
  return CONFIG_PATH
}

export function loadConfig(): AppConfig {
  if (cached) return cached
  if (!existsSync(CONFIG_PATH)) {
    cached = { ...DEFAULT_CONFIG }
    return cached
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    cached = mergeWithDefaults(parsed)
    return cached
  } catch (e) {
    log('fail', `config load error, using defaults: ${(e as Error).message}`)
    cached = { ...DEFAULT_CONFIG }
    return cached
  }
}

export function saveConfig(update: Partial<AppConfig>): AppConfig {
  const current = loadConfig()
  const merged = mergeWithDefaults({ ...current, ...update })
  if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8')
  cached = merged
  log('done', `config saved to ${CONFIG_PATH}`)
  return merged
}

export function resetConfig(): AppConfig {
  cached = { ...DEFAULT_CONFIG }
  return cached
}

function mergeWithDefaults(partial: Partial<AppConfig>): AppConfig {
  return {
    version: 1,
    theme: partial.theme ?? DEFAULT_CONFIG.theme,
    themeCustom: partial.themeCustom,
    models: { ...DEFAULT_CONFIG.models, ...(partial.models ?? {}) },
    hotkey: partial.hotkey ?? DEFAULT_CONFIG.hotkey,
    hudAutoCloseMs: partial.hudAutoCloseMs ?? DEFAULT_CONFIG.hudAutoCloseMs,
    answerAutoCloseMs: partial.answerAutoCloseMs ?? DEFAULT_CONFIG.answerAutoCloseMs,
    wakeWord: { ...DEFAULT_CONFIG.wakeWord, ...(partial.wakeWord ?? {}) },
    historyEnabled: partial.historyEnabled ?? DEFAULT_CONFIG.historyEnabled,
  }
}
