import type { AppConfig } from '../config'
import { agentDwellConfig, dwellSettings, type AgentDwellConfig } from '../a11y/dwell'

export type AgentLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Args of the `init` command: the full agent state, resent after every (re)start. */
export interface AgentInitArgs {
  hotkey: string
  /** Dictation push-to-talk; "" when dictation or its hotkey is off. */
  dictationHotkey: string
  dwell: AgentDwellConfig
  /** Subscribable events to turn on; every other one is turned off. */
  subscriptions: string[]
  logLevel: AgentLogLevel
}

export interface AgentInitOptions {
  /** Primary display scale (the dwell move tolerance is in physical px). */
  scale?: number
  /** focus-changed is wanted by an a11y feature. */
  focusEvents?: boolean
  /** mouse-moved is wanted (follow buddy); guide auto-dismiss comes from the config. */
  mouseEvents?: boolean
  logLevel?: AgentLogLevel
}

export function splitPhrases(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The dictation combo to bind, or "" when dictation is off or it would shadow the main hotkey. */
export function dictationHotkeyOf(cfg: AppConfig, mainHotkey: string): string {
  if (!cfg.dictation.enabled) return ''
  const combo = cfg.dictation.hotkey.trim()
  return combo && combo.toLowerCase() !== mainHotkey.trim().toLowerCase() ? combo : ''
}

/** Agent events main needs while `cfg` (and the a11y features) are as they are. */
export function agentSubscriptions(
  cfg: AppConfig,
  focusEvents = false,
  mouseEvents = false
): string[] {
  const subs: string[] = []
  if (cfg.guideAutoDismissOnMove || mouseEvents) subs.push('mouse-moved')
  if (focusEvents) subs.push('focus-changed')
  return subs
}

export function buildAgentInitState(cfg: AppConfig, opts: AgentInitOptions = {}): AgentInitArgs {
  return {
    hotkey: cfg.hotkey,
    dictationHotkey: dictationHotkeyOf(cfg, cfg.hotkey),
    dwell: agentDwellConfig(dwellSettings(cfg), opts.scale ?? 1),
    subscriptions: agentSubscriptions(cfg, opts.focusEvents, opts.mouseEvents),
    logLevel: opts.logLevel ?? 'info'
  }
}
