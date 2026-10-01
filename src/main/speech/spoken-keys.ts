// Spoken commands around a dictation (04 T40/T47/T48), handled before the dictation pipeline:
//   "… press enter" / "… send it"  → the text is typed, then Enter (never in a terminal or a
//                                     password field; Enter sends in chat apps, so "send it")
//   "… stop dictation"             → just ends the dictation (hands-free), nothing pressed
//   "whisper mode on" / "off"      → the whole utterance toggles whisper mode
// A trailing command only counts as its own clause: at the start, or after . ! ? , or
// "and" / "then", so "can you send it" and "press enter to continue" are typed as text.
import type { AgentBridge } from '../agent/bridge'
import { getAgent } from '../agent/instance'
import { executeActions } from '../actions/executor'
import { withInputLane } from '../agent-mode/input-lane'
import { loadConfig } from '../config'
import { log } from '../logger'
import { patchConfig } from '../ipc/settings'
import { setStatus } from '../windows/assistant'
import { readFocus } from './dictation/insert'
import { isOpaqueIde, isTerminalTarget, type FocusTarget } from './dictation/terminal-guard'

export type SpokenKey = 'enter' | 'send' | 'stop'

export interface SpokenSplit {
  /** What is left to type. */
  text: string
  key: SpokenKey | null
}

const CLAUSE = String.raw`(?:^|(?<=[.!?,;:])\s*|\s+(?:and|then)\s+|(?<=[.!?,;:])\s*(?:and|then)\s+)`
const TAIL = String.raw`[\s.!?,;:]*$`
const CUES: Array<[SpokenKey, RegExp]> = [
  [
    'enter',
    new RegExp(
      `${CLAUSE}(?:press|hit|push)\\s+(?:the\\s+)?(?:enter|return)(?:\\s+key)?${TAIL}`,
      'i'
    )
  ],
  ['send', new RegExp(`${CLAUSE}send\\s+(?:it|that|this)(?:\\s+now)?${TAIL}`, 'i')],
  ['stop', new RegExp(`${CLAUSE}(?:stop|end|finish)\\s+(?:the\\s+)?dictati(?:on|ng)${TAIL}`, 'i')]
]

/** Splits a trailing spoken command off a transcript. Pure. */
export function splitSpokenKey(raw: string): SpokenSplit {
  const text = raw.trim()
  for (const [key, re] of CUES) {
    const m = re.exec(text)
    if (!m) continue
    const body = text
      .slice(0, m.index)
      .replace(/[\s,;:]+$/, '')
      .trim()
    return { text: body, key }
  }
  return { text, key: null }
}

const WHISPER_ON =
  /^(?:turn on |switch on |enable |start )?whisper(?:ing)? mode(?: on)?[.!]?$|^(?:turn |switch )?on whisper mode[.!]?$/i
const WHISPER_OFF =
  /^(?:turn off |switch off |disable |stop |end )whisper(?:ing)? mode[.!]?$|^whisper(?:ing)? mode off[.!]?$/i

/** "whisper mode on" → true, "whisper mode off" → false, anything else → null. Pure. */
export function matchWhisperToggle(raw: string): boolean | null {
  const t = raw.trim().replace(/\s+/g, ' ')
  if (WHISPER_OFF.test(t)) return false
  if (WHISPER_ON.test(t)) return true
  return null
}

export type DictateFn = (text: string) => Promise<{ ok: boolean; notice?: string }>

export interface SpokenKeyDeps {
  spokenKeys: () => boolean
  setWhisper: (on: boolean) => Promise<void>
  focus: () => Promise<FocusTarget | null>
  pressEnter: (userText: string) => Promise<boolean>
  status: (text: string, ok: boolean) => void
}

export const TERMINAL_ENTER = 'Not pressing Enter in a terminal. Press it yourself.'
export const IDE_ENTER =
  'Not pressing Enter here: this IDE may have its terminal focused. Press it yourself.'

async function focusOf(agent: AgentBridge | null): Promise<FocusTarget | null> {
  return agent ? readFocus(agent) : null
}

const appDeps: SpokenKeyDeps = {
  spokenKeys: () => loadConfig().dictation.spokenKeys,
  async setWhisper(on) {
    await patchConfig({ voice: { ...loadConfig().voice, whisperMode: on } })
  },
  focus: () => focusOf(getAgent()),
  async pressEnter(userText) {
    // The user asked for this key by voice: user-direct and already approved (audited).
    const r = await withInputLane(
      'dictation',
      () =>
        executeActions([{ type: 'hotkey', keys: ['enter'] }], {
          origin: 'user-direct',
          approved: true,
          preview: false,
          refine: false,
          userText
        }),
      { user: true }
    )
    return r.executed > 0
  },
  status(text, ok) {
    setStatus(ok ? 'answer' : 'error', text, undefined, ok ? 1500 : 4000)
  }
}

/**
 * The dictation hotkey's transcript with spoken commands applied around `dictate`.
 * Enter is pressed only after the text was typed into a normal field.
 */
export async function dictateWithSpokenKeys(
  raw: string,
  dictate: DictateFn,
  deps: SpokenKeyDeps = appDeps
): Promise<{ ok: boolean; notice?: string }> {
  // dictate("") ends the hotkey session (its gesture state) without typing anything.
  const endSession = (): Promise<unknown> => dictate('').catch(() => undefined)
  const whisper = matchWhisperToggle(raw)
  if (whisper !== null) {
    await endSession()
    await deps.setWhisper(whisper)
    const notice = whisper ? 'Whisper mode on' : 'Whisper mode off'
    log('step', `dictation: ${notice.toLowerCase()}`)
    deps.status(notice, true)
    return { ok: true, notice }
  }
  if (!deps.spokenKeys()) return dictate(raw)
  const { text, key } = splitSpokenKey(raw)
  if (!key || key === 'stop') return dictate(key ? text : raw)
  if (text) {
    const res = await dictate(text)
    // A notice means it was not a plain insert (terminal, note, cancelled, scratched).
    if (!res.ok || res.notice) return res
  } else {
    await endSession()
  }
  const target = await deps.focus()
  if (!target || target.password) return { ok: !!text }
  if (isTerminalTarget(target)) {
    deps.status(TERMINAL_ENTER, false)
    return { ok: !!text, notice: TERMINAL_ENTER }
  }
  // JetBrains, Android Studio, Zed, Fleet: UIA cannot tell their terminal from the editor.
  if (isOpaqueIde(target)) {
    deps.status(IDE_ENTER, false)
    return { ok: !!text, notice: IDE_ENTER }
  }
  // Give the app a moment to take the typed text before Enter.
  if (text) await new Promise((r) => setTimeout(r, 60))
  const pressed = await deps.pressEnter(raw).catch((e: Error) => {
    log('fail', `dictation enter failed: ${e.message}`)
    return false
  })
  log('done', `dictation: ${key === 'send' ? 'sent' : 'pressed enter'}`)
  if (pressed) deps.status(key === 'send' ? 'Sent' : 'Pressed Enter', true)
  return { ok: pressed || !!text }
}
