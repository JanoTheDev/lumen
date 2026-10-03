// Settings by voice (wired in index.ts before interceptLocal): "read answers aloud", "speak
// Spanish", "make your text bigger", "turn on dwell clicking", "open voice settings", "is the
// wake word on?". Grammar in grammar.ts, the rows in table.ts, applying in run.ts; this file
// connects them to patchConfig, the bar's confirm card, the panel window, voices and updates.
import { loadConfig } from '../config'
import { patchConfig } from '../ipc/settings'
import { requestConfirm } from '../windows/assistant'
import * as settingsWin from '../windows/settings'
import { faceInstalled } from '../face/assets'
import { offlineLanguage } from '../speech/stt/local-model'
import { getAgent } from '../agent/instance'
import { ttsVoices } from '../agent/commands'
import { OPENAI_VOICES, openAiTtsAvailable } from '../speech/tts/openai'
import { ttsEngine } from '../speech/tts/turns'
import { pickWinVoice } from '../speech/tts/win-voices'
import { updateService } from '../update'
import { parseSettingsCommand } from './grammar'
import { runSettingsCommand, type SettingsPorts, type VoiceInfo } from './run'
import { SETTINGS } from './table'

export { parseSettingsCommand } from './grammar'

const answer = (text: string): { mode: 'answer'; text: string } => ({ mode: 'answer', text })

async function voices(): ReturnType<SettingsPorts['voices']> {
  const cfg = loadConfig()
  const engine = ttsEngine(
    cfg.voice.tts === 'off' ? 'windows' : cfg.voice.tts,
    openAiTtsAvailable()
  )
  if (engine === 'cloud') {
    const list: VoiceInfo[] = OPENAI_VOICES.map((name) => ({ name, lang: 'auto' }))
    return {
      engine,
      list,
      current: list.find((v) => v.name === cfg.voice.ttsVoice) ?? list[0]
    }
  }
  const bridge = getAgent()
  if (!bridge) throw new Error('no agent')
  const list = (await ttsVoices(bridge)).map((v) => ({
    name: v.name,
    lang: v.lang,
    gender: v.gender
  }))
  const current = pickWinVoice(list, cfg.voice.ttsVoice, cfg.voice.language)
  return {
    engine: 'windows',
    list,
    current: current ? (list.find((v) => v.name === current.name) ?? null) : null
  }
}

const ports: SettingsPorts = {
  config: loadConfig,
  patch: (p) => patchConfig(p),
  confirm: (c) => requestConfirm(c),
  openPanel: (route) => settingsWin.create(route),
  faceInstalled,
  canHear: (lang, cfg) =>
    offlineLanguage(lang) || (cfg.voice.stt !== 'local' && !!process.env.OPENAI_API_KEY),
  voices,
  get update() {
    const s = updateService()
    return s
      ? { status: () => s.status(), check: () => s.check(true), install: () => s.install() }
      : null
  }
}

/**
 * Settings voice commands. Returns the response's promise when handled, undefined to go on
 * with the normal chain.
 */
export function interceptSettings(prompt: string): unknown | undefined {
  const cmd = parseSettingsCommand(prompt)
  if (!cmd) return undefined
  // "install the update" without Lumen in the words is Windows' unless Lumen has one ready.
  if (cmd.kind === 'update-install' && !cmd.scoped && updateService()?.status().state !== 'ready')
    return undefined
  return runSettingsCommand(cmd, ports).then(answer, (e: unknown) => {
    console.error('[voice-settings] failed:', (e as Error).message)
    return answer('I couldn’t change that setting.')
  })
}

/** Rows for the "what can I say" sheet. */
export function settingsVoiceHelp(): { say: string; does: string }[] {
  return [
    { say: 'open voice settings', does: 'Open a page of Lumen’s settings' },
    ...SETTINGS.flatMap((r) => (r.help ? [r.help] : [])),
    { say: 'use a female voice', does: 'Change Lumen’s voice ("what voices do you have")' },
    { say: 'is the wake word on', does: 'Hear how a setting is set' },
    { say: 'check for Lumen updates', does: 'Check for a new version' },
    { say: 'start setup again', does: 'Go through Lumen’s setup again' }
  ]
}
