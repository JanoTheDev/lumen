// Pushes hotkey, listener (wake word + cancel phrases) and dwell settings to the agent.
import { getAgent } from './instance'
import { dictationHotkeyOf } from './state'
import type { AppConfig } from '../config'
import { applyWakeState } from '../speech/wake'
import * as dwellRing from '../windows/dwell-ring'

export function applyDwellState(cfg: AppConfig): void {
  const agent = getAgent()
  if (!agent) return
  if (cfg.dwellClick.enabled) {
    agent
      .enableDwell(cfg.dwellClick.dwellMs, cfg.dwellClick.cooldownMs)
      .catch((e) => console.error('[dwell] enable failed:', (e as Error).message))
  } else {
    agent.disableDwell().catch(() => {})
  }
  dwellRing.setEnabled(cfg.dwellClick.enabled)
}

/** Wake word + voice cancel: keyword spotter in main, or the agent's Vosk listener. */
export function applyListenerState(cfg: AppConfig): void {
  applyWakeState(cfg)
}

/** Full state, re-sent after every agent (re)start. */
export async function applyAgentState(cfg: AppConfig): Promise<void> {
  const agent = getAgent()
  if (!agent) return
  try {
    await agent.setHotkey(cfg.hotkey)
  } catch (e) {
    console.error('[hotkey] bind failed:', (e as Error).message)
  }
  await applyDictationHotkey(cfg)
  applyListenerState(cfg)
  applyDwellState(cfg)
}

/** Binds (or unbinds) the dictation hotkey; an old agent without the command is ignored. */
export async function applyDictationHotkey(cfg: AppConfig): Promise<void> {
  const agent = getAgent()
  if (!agent) return
  try {
    await agent.setDictationHotkey(dictationHotkeyOf(cfg, cfg.hotkey))
  } catch (e) {
    console.error('[dictation] hotkey bind failed:', (e as Error).message)
  }
}

export function setHotkey(combo: string): Promise<unknown> {
  return getAgent()?.setHotkey(combo) ?? Promise.resolve()
}
