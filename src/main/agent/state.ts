import type { AppConfig } from '../config'

export type AgentLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Args of the v2 `init` command: the full agent state, resent after every restart. */
export interface AgentInitArgs {
  hotkey: string
  /** Dictation push-to-talk; "" when dictation or its hotkey is off. */
  dictationHotkey: string
  wake: { enabled: boolean; phrase: string; cancelPhrases: string[] }
  dwell: { enabled: boolean; ms: number; cooldownMs: number }
  logLevel: AgentLogLevel
}

const DEFAULT_HOTKEY = 'Ctrl+Shift+Space'
const DEFAULT_DWELL_MS = 1400
const DEFAULT_COOLDOWN_MS = 1500

type Loose = Record<string, unknown>

function obj(v: unknown): Loose {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {}
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function splitPhrases(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The dictation combo to bind, or "" when dictation is off or it would shadow the main hotkey. */
export function dictationHotkeyOf(cfg: unknown, mainHotkey: string): string {
  const d = obj(obj(cfg).dictation)
  if (d.enabled === false) return ''
  const combo = str(d.hotkey, '').trim()
  return combo && combo.toLowerCase() !== mainHotkey.trim().toLowerCase() ? combo : ''
}

export function buildAgentInitState(
  cfg: AppConfig | Partial<AppConfig> | null | undefined,
  logLevel: AgentLogLevel = 'info'
): AgentInitArgs {
  const c = obj(cfg)
  const wakeWord = obj(c.wakeWord)
  const cancelVoice = obj(c.cancelVoice)
  const dwellClick = obj(c.dwellClick)
  const hotkey = str(c.hotkey, DEFAULT_HOTKEY) || DEFAULT_HOTKEY

  const phrase = str(wakeWord.phrase, '').trim()
  return {
    hotkey,
    dictationHotkey: dictationHotkeyOf(c, hotkey),
    wake: {
      enabled: wakeWord.enabled === true && phrase.length > 0,
      phrase,
      cancelPhrases: cancelVoice.enabled === true ? splitPhrases(cancelVoice.phrases) : []
    },
    dwell: {
      enabled: dwellClick.enabled === true,
      ms: num(dwellClick.dwellMs, DEFAULT_DWELL_MS),
      cooldownMs: num(dwellClick.cooldownMs, DEFAULT_COOLDOWN_MS)
    },
    logLevel
  }
}
