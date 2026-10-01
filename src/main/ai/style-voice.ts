// Voice commands for reply styles: "turn on caveman mode", "caveman mode ultra", "caveman mode
// off", "normal mode", "what mode am I in", "set the level to lite", "make a style that talks
// like a pirate". Only names of installed styles match, so "focus mode on" and other modes
// pass through to their own handlers. Pure: the caller applies the result. No Electron.
import { spokenStyleName, type ActiveStyle, type StyleInfo } from '@shared/styles'

export type StyleCommand =
  | { cmd: 'on'; name: string; level?: string; badLevel?: string }
  | { cmd: 'off'; name?: string }
  | { cmd: 'which' }
  | { cmd: 'level'; level: string }
  | { cmd: 'make'; like: string }

/** Lowercase words, apostrophes dropped ("I'm" → "im"), no punctuation, no "please". */
export function normStyleUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:ok|okay|hey lumen|lumen|please|now)\s+/, '')
    .replace(/\s+(?:please|now|again)$/, '')
    .trim()
}

const ON_VERBS =
  /^(?:turn on|switch on|switch to|switch into|change to|use|enable|start|activate|go into|go to|put on|be in|talk in|reply in) (?:the )?/
const OFF_VERBS = /^(?:turn off|switch off|stop|disable|exit|leave|end|quit|cancel) (?:the )?/
const GENERIC_OFF =
  /^(?:(?:normal|default|regular|standard) (?:mode|style|wording|replies)|(?:turn off|switch off|stop|disable|no more|clear) (?:the |any |my )?(?:reply )?(?:style|styles|mode)|(?:reply )?style off|no style|(?:talk|speak|reply) normally(?: again)?)$/
const WHICH =
  /^(?:what|which) (?:reply )?(?:mode|style) (?:am i in|are you in|are you using|is on|is active|is this|is it|is that)$|^(?:what|which) (?:mode|style)$/
const LEVEL_ONLY = [
  /^(?:set|switch|change|go)(?: the)?(?: style| mode)? level to (.+)$/,
  /^(?:the )?(?:style |mode )?level (.+)$/,
  /^(.+) level$/
]
const MAKE = [
  /^(?:make|create|build|write|add) (?:me )?(?:a |an )?(?:new )?(?:reply )?(?:style|mode)(?: that| which| to)? (?:talks|speaks|sounds|writes|answers|replies|talk|speak|sound) like (.+)$/,
  /^(?:make|create|build|add) (?:me )?(?:a |an )?(?:new )?(.+?) (?:reply )?(?:style|mode)$/
]

/** The longest installed style whose spoken name ends `words`, and the words before it. */
function styleAtEnd(
  words: string[],
  styles: readonly StyleInfo[]
): { style: StyleInfo; rest: string[] } | null {
  let best: { style: StyleInfo; rest: string[]; len: number } | null = null
  for (const s of styles) {
    const name = normStyleUtterance(spokenStyleName(s.name)).split(' ')
    if (name.length > words.length) continue
    const tail = words.slice(words.length - name.length)
    if (tail.join(' ') !== name.join(' ')) continue
    if (!best || name.length > best.len)
      best = { style: s, rest: words.slice(0, words.length - name.length), len: name.length }
  }
  return best && { style: best.style, rest: best.rest }
}

const LEVEL_FILLER = new Set(['at', 'on', 'in', 'level', 'to', 'the', 'set', 'mode', 'style'])

/** A level word (or two) said around the name: "ultra", "level ultra", "at lite level". */
function levelWords(words: string[]): string {
  return words.filter((w) => !LEVEL_FILLER.has(w)).join('-')
}

function withLevel(style: StyleInfo, said: string): StyleCommand {
  if (!said) return { cmd: 'on', name: style.name }
  if (style.levels.includes(said)) return { cmd: 'on', name: style.name, level: said }
  return { cmd: 'on', name: style.name, badLevel: said }
}

/**
 * The style command a whole utterance gives, or null. `styles` is every installed style;
 * `active` the one in use (for level-only commands).
 */
export function matchStyleCommand(
  utterance: string,
  styles: readonly StyleInfo[],
  active: ActiveStyle | null = null
): StyleCommand | null {
  const n = normStyleUtterance(utterance)
  if (!n || n.length > 120) return null
  if (WHICH.test(n)) return { cmd: 'which' }
  for (const re of MAKE) {
    const m = re.exec(n)
    if (m && m[1] && !/^(?:normal|default|regular|this|that|the)$/.test(m[1]))
      return { cmd: 'make', like: m[1] }
  }
  if (GENERIC_OFF.test(n)) return { cmd: 'off' }

  const off = OFF_VERBS.exec(n)
  const offNamed = /^(.+) (?:mode|style) off$/.exec(n)
  if (off || offNamed) {
    const body = offNamed ? offNamed[1] : n.slice(off![0].length).replace(/ (?:mode|style)$/, '')
    const hit = styleAtEnd(body.split(' '), styles)
    return hit && !hit.rest.length ? { cmd: 'off', name: hit.style.name } : null
  }

  // "<verb> <level?> <name> mode|style <level?> [on]"
  const words = n.replace(ON_VERBS, '').replace(/ on$/, '').split(' ')
  const at = words.findIndex((w) => w === 'mode' || w === 'style')
  if (at > 0) {
    const hit = styleAtEnd(words.slice(0, at), styles)
    if (hit) {
      const before = levelWords(hit.rest)
      const after = levelWords(words.slice(at + 1))
      if (before && after) return null
      return withLevel(hit.style, before || after)
    }
  }
  // "set caveman level to ultra" / "caveman level ultra"
  const lv = /^(?:set |change )?(.+?) level (?:to )?(.+)$/.exec(n)
  if (lv) {
    const hit = styleAtEnd(lv[1].split(' '), styles)
    if (hit && !hit.rest.length) return withLevel(hit.style, levelWords(lv[2].split(' ')))
  }
  if (active) {
    const style = styles.find((s) => s.name === active.name)
    for (const re of LEVEL_ONLY) {
      const m = re.exec(n)
      const level = m ? levelWords(m[1].split(' ')) : ''
      if (style && level && style.levels.includes(level)) return { cmd: 'level', level }
    }
  }
  return null
}

const listOf = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`

export interface StyleVoiceResult {
  /** What to say back. */
  text: string
  /** The new setting, when it changes (null = off). */
  set?: ActiveStyle | null
}

/** Applies a command to the current state: what to say and the new setting. */
export function applyStyleCommand(
  c: Exclude<StyleCommand, { cmd: 'make' }>,
  styles: readonly StyleInfo[],
  active: ActiveStyle | null
): StyleVoiceResult {
  const say = (name: string): string => spokenStyleName(name)
  const current = active ? styles.find((s) => s.name === active.name) : undefined
  switch (c.cmd) {
    case 'which': {
      if (!active || !current)
        return {
          text: styles.length
            ? `No reply style is on. You can say: turn on ${say(styles[0].name)} mode.`
            : 'No reply style is on.'
        }
      const level = active.level ?? current.levels[0]
      return {
        text: `${cap(say(current.name))} mode is on${level && current.levels.length > 1 ? `, level ${level}` : ''}. Say "normal mode" to turn it off.`
      }
    }
    case 'off':
      if (!active) return { text: 'No reply style is on.' }
      if (c.name && c.name !== active.name)
        return { text: `${cap(say(c.name))} mode is not on. ${cap(say(active.name))} mode is.` }
      return { text: `${cap(say(active.name))} mode is off.`, set: null }
    case 'level': {
      if (!active || !current) return { text: 'No reply style is on.' }
      return {
        text: `${cap(say(current.name))} mode, level ${c.level}.`,
        set: { name: current.name, level: c.level }
      }
    }
    case 'on': {
      const style = styles.find((s) => s.name === c.name)!
      if (!style.enabled)
        return {
          text: `${cap(say(style.name))} is switched off in Settings, under Skills. Switch it on there first.`
        }
      if (c.badLevel)
        return {
          text: style.levels.length
            ? `${cap(say(style.name))} mode has the levels ${listOf(style.levels)}.`
            : `${cap(say(style.name))} mode has no levels.`
        }
      const level = c.level ?? style.levels[0]
      const note =
        style.trust === 'community-untrusted'
          ? ' It is a community style you have not trusted yet, so only a short part of it is used.'
          : ''
      return {
        text: `${cap(say(style.name))} mode is on${level && style.levels.length > 1 ? `, level ${level}` : ''}.${note}`,
        set: { name: style.name, ...(c.level ? { level: c.level } : {}) }
      }
    }
  }
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
