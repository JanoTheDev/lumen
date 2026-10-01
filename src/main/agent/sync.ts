// Pushes hotkey, subscription and dwell settings to the agent; `init` carries all of it on start.
import { getAgent } from './instance'
import { buildAgentInitState, dictationHotkeyOf, type AgentInitArgs } from './state'
import { mouseEvents } from './subscriptions'
import type { AppConfig } from '../config'
import { screen } from 'electron'
import { agentDwellConfig, dwellSettings } from '../a11y/dwell'
import { focusEventsWanted } from '../a11y/focus-events'
import { applyWakeState } from '../speech/wake'
import * as dwellPalette from '../windows/dwell-palette'
import * as dwellRing from '../windows/dwell-ring'

/** The `init` args for a fresh agent. */
export function agentInitArgs(cfg: AppConfig): AgentInitArgs {
  return buildAgentInitState(cfg, {
    scale: screen.getPrimaryDisplay().scaleFactor,
    focusEvents: focusEventsWanted(),
    mouseEvents: mouseEvents.wanted()
  })
}

/** Dwell tracker settings to the agent, plus ring and palette. */
export function applyDwellState(cfg: AppConfig): void {
  dwellRing.setEnabled(cfg.dwellClick.enabled)
  dwellPalette.setVisible(cfg.dwellClick.enabled && cfg.a11y.dwell.palette)
  const agent = getAgent()
  if (!agent?.hasCapability('dwell')) return
  const scale = screen.getPrimaryDisplay().scaleFactor
  agent
    .request('dwell_config', { ...agentDwellConfig(dwellSettings(cfg), scale) })
    .catch((e) => console.error('[dwell] config failed:', (e as Error).message))
}

/** Wake word + voice cancel: the keyword spotter in main. */
export function applyListenerState(cfg: AppConfig): void {
  applyWakeState(cfg)
}

/** Binds (or unbinds) the dictation hotkey. */
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
