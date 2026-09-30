// Pushes hotkey, listener (wake word + cancel phrases) and dwell settings to the agent.
import { getAgent } from './instance'
import { splitPhrases } from './state'
import type { AppConfig } from '../config'
import { installModel, modelInstalled } from '../wake-model'
import * as dwellRing from '../windows/dwell-ring'

function cancelPhraseList(cfg: AppConfig): string[] {
  return cfg.cancelVoice.enabled ? splitPhrases(cfg.cancelVoice.phrases) : []
}

export function applyDwellState(cfg: AppConfig): void {
  const agent = getAgent()
  if (!agent) return
  if (cfg.dwellClick.enabled) {
    agent.enableDwell(cfg.dwellClick.dwellMs, cfg.dwellClick.cooldownMs).catch(e =>
      console.error('[dwell] enable failed:', (e as Error).message))
  } else {
    agent.disableDwell().catch(() => {})
  }
  dwellRing.setEnabled(cfg.dwellClick.enabled)
}

export function applyListenerState(cfg: AppConfig): void {
  const agent = getAgent()
  if (!agent) return
  const wakeOn = cfg.wakeWord.enabled && cfg.wakeWord.phrase.trim().length > 0
  const cancelOn = cfg.cancelVoice.enabled
  if (!wakeOn && !cancelOn) {
    agent.disableListener().catch(() => {})
    return
  }
  if (!modelInstalled()) {
    installModel()
      .then(() => getAgent()?.enableListener(wakeOn ? cfg.wakeWord.phrase : '', cancelPhraseList(cfg)))
      .catch(e => console.error('[listener] model install failed:', (e as Error).message))
    return
  }
  agent.enableListener(wakeOn ? cfg.wakeWord.phrase : '', cancelPhraseList(cfg))
    .catch(e => console.error('[listener] enable failed:', (e as Error).message))
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
  applyListenerState(cfg)
  applyDwellState(cfg)
}

export function setHotkey(combo: string): Promise<unknown> {
  return getAgent()?.setHotkey(combo) ?? Promise.resolve()
}
