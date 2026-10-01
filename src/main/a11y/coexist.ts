// Living with other voice control and screen readers (06 T20). Pure.
//
// Voice Access and Dragon listen all the time, so while Lumen records they hear the same words.
// For commands both understand ("show numbers", "scroll down", "click 5") Lumen steps aside
// unless the user says "Lumen" first; Lumen-only commands ("describe screen", "pin") still run.
// Dragon also owns the microphone, so the wake word is suspended while it runs (configurable).
// Screen readers need nothing here: the announce policy (announce.ts) routes through them.
import type { AtState } from './at-state'
import type { Category, Command, CommandContext } from './voice-commands'

const NAMES: Record<string, string> = {
  'voice-access': 'Voice Access',
  dragon: 'Dragon'
}

/** Command families Voice Access and Dragon also have. */
const SHARED: ReadonlySet<Category> = new Set([
  'numbers',
  'grid',
  'pointer',
  'scroll',
  'keyboard',
  'navigation',
  'windows'
])

export interface CoexistConfig {
  wakeWord: { enabled: boolean }
  a11y: { coexist: { yieldToVoiceControl: boolean; wakeWithDragon: boolean } }
}

/** The voice control Lumen yields to right now ("Voice Access"), or null. */
export function voiceControlName(at: AtState, cfg: CoexistConfig): string | null {
  if (!cfg.a11y.coexist.yieldToVoiceControl) return null
  const id = at.voiceControl.find((v) => NAMES[v])
  return id ? NAMES[id] : at.voiceControl.length ? 'your voice control app' : null
}

/** "Lumen, scroll down" / "hey Lumen show numbers": said to Lumen on purpose. */
export function addressedToLumen(utterance: string): boolean {
  return /^\W*(hey\s+|ok(ay)?\s+)?lumen\b/i.test(utterance)
}

/**
 * Whether Lumen should leave `cmd` to the other voice control. Commands on Lumen's own
 * overlays (its numbers or grid are up) are Lumen's: the other app has no such numbers.
 */
export function shouldYield(
  cmd: Pick<Command, 'category'>,
  utterance: string,
  ctx: CommandContext,
  who: string | null
): boolean {
  if (!who || !SHARED.has(cmd.category)) return false
  if (addressedToLumen(utterance)) return false
  if (cmd.category === 'numbers' && ctx.marksShown) return false
  if (cmd.category === 'grid' && ctx.gridShown) return false
  return true
}

/** The wake word stays off while Dragon runs, unless the user asked to keep it. */
export function wakeSuspended(at: AtState, cfg: CoexistConfig): boolean {
  return (
    cfg.wakeWord.enabled && at.voiceControl.includes('dragon') && !cfg.a11y.coexist.wakeWithDragon
  )
}

/** The config the wake spotter should run with (wake word cleared while suspended). */
export function wakeConfig<T extends CoexistConfig>(cfg: T, at: AtState): T {
  return wakeSuspended(at, cfg) ? { ...cfg, wakeWord: { ...cfg.wakeWord, enabled: false } } : cfg
}

/**
 * Global keys that assistive tech and Windows use; Lumen's a11y shortcuts must not take them
 * (normalized as in shortcuts.ts: ctrl, alt, shift, win, then the key).
 */
export const AT_HOTKEYS: ReadonlyMap<string, string> = new Map([
  ['alt+shift+b', 'Voice Access (microphone on/off)'],
  ['ctrl+win+enter', 'Narrator (start/stop)'],
  ['ctrl+alt+n', 'NVDA (start)'],
  ['win+h', 'Windows voice typing'],
  ['win+u', 'Windows accessibility settings'],
  ['ctrl+win+s', 'Windows Speech Recognition'],
  ['ctrl+win+o', 'the On-Screen Keyboard'],
  ['win+plus', 'Magnifier'],
  ['win+=', 'Magnifier'],
  ['win+esc', 'Magnifier (exit)']
])

/** One line for the bar/log when assistive tech starts or stops. */
export function coexistNotice(prev: AtState, next: AtState, cfg: CoexistConfig): string | null {
  const started = next.voiceControl.filter((v) => !prev.voiceControl.includes(v))
  if (!started.length) return null
  const who = voiceControlName(next, cfg)
  const wake = wakeSuspended(next, cfg) ? ' The wake word is off while Dragon runs.' : ''
  if (!who) return wake ? wake.trim() : null
  return `${who} is running. Say "Lumen" before mouse and keyboard commands meant for Lumen.${wake}`
}
