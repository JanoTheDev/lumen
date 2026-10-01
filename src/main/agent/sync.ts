// Pushes hotkey, listener (wake word + cancel phrases) and dwell settings to the agent.
import { getAgent } from './instance'
import { dictationHotkeyOf } from './state'
import type { AppConfig } from '../config'
import { screen } from 'electron'
import { agentDwellConfig, dwellSettings } from '../a11y/dwell'
import { applyWakeState } from '../speech/wake'
import * as dwellPalette from '../windows/dwell-palette'
import * as dwellRing from '../windows/dwell-ring'

/** Dwell tracker settings to the agent (full dwell_config on v2), plus ring and palette. */
export function applyDwellState(cfg: AppConfig): void {
  dwellRing.setEnabled(cfg.dwellClick.enabled)
  dwellPalette.setVisible(cfg.dwellClick.enabled && cfg.a11y.dwell.palette)
  const agent = getAgent()
  if (!agent) return
  if (agent.protocol === 2 && agent.hasCapability('dwell')) {
    const scale = screen.getPrimaryDisplay().scaleFactor
    agent
      .request('dwell_config', { ...agentDwellConfig(dwellSettings(cfg), scale) })
      .catch((e) => console.error('[dwell] config failed:', (e as Error).message))
  } else if (cfg.dwellClick.enabled) {
    agent
      .enableDwell(cfg.dwellClick.dwellMs, cfg.dwellClick.cooldownMs)
      .catch((e) => console.error('[dwell] enable failed:', (e as Error).message))
  } else {
    agent.disableDwell().catch(() => {})
  }
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
