// Accessibility profiles: named partial config patches picked in onboarding or Settings.
// Several can be combined; conflicts resolve to the more accessible value.
import type { ConfigPatch, ConfigV2 } from './config'

export const PROFILE_IDS = [
  'standard',
  'motor-voice',
  'motor-pointer',
  'eye-gaze',
  'switch',
  'low-vision',
  'blind',
  'deaf-hoh',
  'speech',
  'cognitive'
] as const

export type ProfileId = (typeof PROFILE_IDS)[number]

type Value = string | number | boolean
/** Dotted config path → value, e.g. `a11y.dwell.radiusPx: 30`. */
export type FlatPatch = Record<string, Value>

export interface Profile {
  /** Short name for Settings, e.g. "Motor – voice". */
  name: string
  /** First-person choice text for the onboarding picker. */
  choice: string
  description: string
  patch: FlatPatch
}

export const PROFILES: Record<ProfileId, Profile> = {
  standard: {
    name: 'Standard',
    choice: 'I can use a mouse and keyboard',
    description: 'Hold a shortcut and talk. Lumen points and explains.',
    patch: {
      'buddy.enabled': true,
      'voice.tts': 'windows',
      answerAutoCloseMs: 10_000,
      'agent.confirm': 'risky'
    }
  },
  'motor-voice': {
    name: 'Motor – voice',
    choice: 'I use my voice',
    description: 'Say “hey Lumen” and control the PC by voice, no hands needed.',
    patch: {
      'wakeWord.enabled': true,
      handsFreeMode: true,
      'a11y.voiceCommands': true,
      'a11y.marks.keep': true,
      answerAutoCloseMs: 0,
      'agent.confirm': 'risky',
      guideAutoDismissOnMove: false,
      'buddy.size': 'l'
    }
  },
  'motor-pointer': {
    name: 'Motor – pointer',
    choice: 'I have trouble clicking',
    description: 'Rest the pointer on something to click it.',
    patch: {
      'dwellClick.enabled': true,
      'dwellClick.dwellMs': 1000,
      'a11y.dwell.radiusPx': 12,
      'a11y.dwell.smoothing': 0.3,
      'a11y.dwell.snapToElement': true,
      'a11y.dwell.maxRepeats': 0,
      'a11y.dwell.ringSize': 'l',
      'a11y.dwell.palette': true,
      'a11y.dwell.safeTargets': true,
      answerAutoCloseMs: 0,
      guideAutoDismissOnMove: false
    }
  },
  'eye-gaze': {
    name: 'Eye gaze',
    choice: 'I use eye gaze',
    description: 'Bigger targets and a longer, steadier dwell for eye trackers.',
    patch: {
      'dwellClick.enabled': true,
      'dwellClick.dwellMs': 1200,
      'a11y.dwell.radiusPx': 30,
      'a11y.dwell.smoothing': 0.5,
      'a11y.dwell.snapToElement': true,
      'a11y.dwell.ringSize': 'xl',
      'a11y.dwell.palette': true,
      'a11y.uiScale': 1.4,
      'a11y.marks.badgeSize': 'l',
      answerAutoCloseMs: 0
    }
  },
  switch: {
    name: 'Switch',
    choice: 'I use switches',
    description: 'Lumen moves through choices and you press your switch to pick.',
    patch: {
      'a11y.switch.enabled': true,
      'a11y.switch.mode': 'auto',
      'a11y.switch.scanIntervalMs': 1500,
      answerAutoCloseMs: 0
    }
  },
  'low-vision': {
    name: 'Low vision',
    choice: 'I have low vision',
    description: 'Larger text, high contrast and spoken answers.',
    patch: {
      'a11y.uiScale': 1.6,
      'a11y.contrast': 'on',
      theme: 'high-contrast',
      'buddy.size': 'l',
      'voice.tts': 'windows',
      'a11y.focusNarration': true,
      'a11y.captions': true,
      answerAutoCloseMs: 0
    }
  },
  blind: {
    name: 'Screen reader',
    choice: 'I use a screen reader',
    description: 'Lumen talks through your screen reader and describes the screen.',
    patch: {
      'a11y.announce': 'auto',
      'voice.tts': 'off',
      'buddy.enabled': false,
      'a11y.focusNarration': false,
      answerAutoCloseMs: 0
    }
  },
  'deaf-hoh': {
    name: 'Deaf or hard of hearing',
    choice: 'I’m deaf or hard of hearing',
    description: 'Everything is shown as text. Lumen checks what it heard before acting.',
    patch: {
      'voice.tts': 'off',
      'a11y.captions': true,
      'a11y.confirmTranscript': 'always'
    }
  },
  speech: {
    name: 'Speech',
    choice: 'Speaking is hard for me',
    description: 'More time to finish speaking, and typing always works.',
    patch: {
      'a11y.confirmTranscript': 'always',
      'vad.silenceMs': 2500,
      'wakeWord.enabled': false
    }
  },
  cognitive: {
    name: 'Simple',
    choice: 'Keep things simple',
    description: 'One step at a time, plain words, slower speech.',
    patch: {
      'a11y.simpleMode': true,
      answerAutoCloseMs: 0,
      'voice.ttsRate': 0.85,
      'agent.confirm': 'always',
      'a11y.reduceMotion': 'on',
      explainBeforeDo: true
    }
  }
}

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v)
}

// ---- Merge rules ----

/** Booleans where "off" is the accessible choice when profiles disagree (e.g. blind → no buddy). */
const OFF_WINS = new Set([
  'buddy.enabled',
  'wakeWord.enabled',
  'a11y.focusNarration',
  'guideAutoDismissOnMove'
])
const MIN_WINS = new Set(['voice.ttsRate', 'a11y.dwell.maxRepeats'])
/** 0 means "never auto-close", which beats any timeout. */
const ZERO_WINS = new Set(['answerAutoCloseMs'])
/** Enum preference, most accessible first. */
const RANKS: Record<string, readonly string[]> = {
  'voice.tts': ['off', 'windows', 'cloud'],
  'agent.confirm': ['always', 'risky', 'never'],
  'a11y.confirmTranscript': ['always', 'risky', 'off'],
  'a11y.announce': ['auto', 'off'],
  'a11y.reduceMotion': ['on', 'system', 'off'],
  'a11y.contrast': ['on', 'system', 'off'],
  'a11y.dwell.ringSize': ['xl', 'l', 'm', 's'],
  'a11y.marks.badgeSize': ['l', 'm', 's'],
  'buddy.size': ['l', 'm', 's']
}

function pick(path: string, a: Value, b: Value): Value {
  if (typeof a === 'boolean' && typeof b === 'boolean') return OFF_WINS.has(path) ? a && b : a || b
  if (typeof a === 'number' && typeof b === 'number') {
    if (ZERO_WINS.has(path) && (a === 0 || b === 0)) return 0
    return MIN_WINS.has(path) ? Math.min(a, b) : Math.max(a, b)
  }
  const rank = RANKS[path]
  if (rank && typeof a === 'string' && typeof b === 'string') {
    const ia = rank.indexOf(a)
    const ib = rank.indexOf(b)
    return ib >= 0 && (ia < 0 || ib < ia) ? b : a
  }
  return a
}

/** The combined flat patch for a set of profiles. Unknown ids are ignored. */
export function mergeProfiles(ids: readonly string[]): FlatPatch {
  const out: FlatPatch = {}
  for (const id of ids) {
    if (!isProfileId(id)) continue
    for (const [path, value] of Object.entries(PROFILES[id].patch)) {
      out[path] = path in out ? pick(path, out[path], value) : value
    }
  }
  return out
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

type Obj = Record<string, unknown>

/**
 * A settings patch that applies `ids` on top of `cfg`. saveConfig merges one level deep, so
 * nested objects (a11y.dwell, a11y.switch, …) are sent whole, filled from the current config.
 */
export function profilePatch(cfg: ConfigV2, ids: readonly string[]): ConfigPatch {
  const chosen = ids.filter(isProfileId)
  const patch: Obj = { a11y: { profiles: chosen } }
  for (const [path, value] of Object.entries(mergeProfiles(chosen))) {
    const [top, mid, leaf] = path.split('.')
    if (mid === undefined) {
      patch[top] = value
      continue
    }
    const section = (patch[top] ??= {}) as Obj
    if (leaf === undefined) {
      section[mid] = value
      continue
    }
    const base = (getPath(cfg, `${top}.${mid}`) ?? {}) as Obj
    section[mid] = { ...base, ...((section[mid] as Obj) ?? {}), [leaf]: value }
  }
  return patch as ConfigPatch
}

/** Paths where the config no longer matches its chosen profiles. */
export function diffFromProfile(cfg: ConfigV2): string[] {
  const expected = mergeProfiles(cfg.a11y.profiles)
  return Object.entries(expected)
    .filter(([path, value]) => getPath(cfg, path) !== value)
    .map(([path]) => path)
}

/** "Low vision + Motor – pointer", or "Custom (based on …)" once the user changed something. */
export function profileSummary(cfg: ConfigV2): string {
  const names = cfg.a11y.profiles.filter(isProfileId).map((id) => PROFILES[id].name)
  if (!names.length) return ''
  const joined = names.join(' + ')
  return diffFromProfile(cfg).length ? `Custom (based on ${joined})` : joined
}

// ---- Plain-language preview ----

const ms = (v: Value): string => `${Number(v) / 1000} s`
const SIZE: Record<string, string> = { s: 'small', m: 'medium', l: 'large', xl: 'extra large' }

const DESCRIBE: Record<string, (v: Value) => string | null> = {
  'buddy.enabled': (v) => (v ? 'The pointing buddy shows on screen' : 'No pointing buddy'),
  'buddy.size': (v) => `Pointing buddy: ${SIZE[String(v)] ?? v}`,
  'voice.tts': (v) =>
    v === 'off' ? 'Lumen doesn’t speak answers out loud' : 'Lumen reads answers out loud',
  'voice.ttsRate': (v) => (Number(v) < 1 ? 'Slower speech' : null),
  answerAutoCloseMs: (v) =>
    v === 0 ? 'Answers stay until you close them' : `Answers close after ${ms(v)}`,
  'agent.confirm': (v) =>
    v === 'always' ? 'Lumen asks before every action' : 'Lumen asks before risky actions',
  'wakeWord.enabled': (v) => (v ? 'Say “hey Lumen” to start' : 'No wake word'),
  handsFreeMode: (v) => (v ? 'Tap the shortcut once, then talk' : null),
  'a11y.voiceCommands': (v) => (v ? 'Voice commands like “click 4” and “scroll down”' : null),
  'a11y.marks.keep': (v) => (v ? 'Numbers stay on screen after a click' : null),
  guideAutoDismissOnMove: (v) => (v ? null : 'Highlights stay when the mouse moves'),
  'dwellClick.enabled': (v) => (v ? 'Dwell clicking: rest the pointer to click' : null),
  'dwellClick.dwellMs': (v) => `Dwell time ${ms(v)}`,
  'a11y.dwell.radiusPx': (v) => (Number(v) > 12 ? 'Dwell allows more hand or eye movement' : null),
  'a11y.dwell.smoothing': (v) => (Number(v) > 0 ? 'Pointer jitter smoothed' : null),
  'a11y.dwell.snapToElement': (v) => (v ? 'Dwell snaps to the nearest button' : null),
  'a11y.dwell.palette': (v) => (v ? 'Click-type palette (right, double, drag)' : null),
  'a11y.switch.enabled': (v) => (v ? 'Switch scanning' : null),
  'a11y.switch.scanIntervalMs': (v) => `Scanning moves every ${ms(v)}`,
  'a11y.uiScale': (v) => `Interface size ${Math.round(Number(v) * 100)}%`,
  'a11y.marks.badgeSize': (v) => `Number badges: ${SIZE[String(v)] ?? v}`,
  'a11y.contrast': (v) => (v === 'on' ? 'High contrast' : null),
  theme: (v) => (v === 'high-contrast' ? 'High contrast colours' : null),
  'a11y.focusNarration': (v) => (v ? 'Lumen says the name of what has focus' : null),
  'a11y.captions': (v) => (v ? 'Captions for what Lumen hears and says' : null),
  'a11y.announce': (v) => (v === 'auto' ? 'Answers go to your screen reader' : null),
  'a11y.confirmTranscript': (v) =>
    v === 'always' ? 'Lumen shows what it heard and waits for “yes”' : null,
  'vad.silenceMs': (v) => `Lumen waits ${ms(v)} of silence before you’re done`,
  'a11y.simpleMode': (v) => (v ? 'Simple mode: one step at a time, plain words' : null),
  'a11y.reduceMotion': (v) => (v === 'on' ? 'Less motion' : null),
  explainBeforeDo: (v) => (v ? 'Lumen explains before it acts' : null)
}

/** Readable list of what applying `ids` changes compared to `cfg`. */
export function describeChanges(cfg: ConfigV2, ids: readonly string[]): string[] {
  const out: string[] = []
  for (const [path, value] of Object.entries(mergeProfiles(ids))) {
    if (getPath(cfg, path) === value) continue
    const text = DESCRIBE[path]?.(value)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}
