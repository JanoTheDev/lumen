// Settings by voice, pure: whole utterances only, short, matched on normalized words.
//
// Which words are claimed (anything else goes on to the model and the app in front):
// - Names only Lumen has ("spoken replies", "wake word", "simple mode", "dwell clicking",
//   "switch access", "face gestures", "smart helpers" names, "local only", …): claimed as said,
//   "turn on simple mode".
// - Names an app could also mean ("dark mode", "theme", "text size", "high contrast", "captions",
//   "automatic updates", "check for updates", the Windows-shared Settings pages "privacy",
//   "about", "general", "microphone"): claimed only when the words also say Lumen: "… in Lumen",
//   "Lumen's …", "Lumen …" after the first word, or "your …" (said to Lumen). A leading
//   "Lumen," is just the address and does not count: "Lumen, turn on dark mode" in Word could
//   mean Word.
// - The whole utterance must be the command: "how do I turn on dark mode in Word", "turn on
//   dark mode in Word" and "what is memory" never match (a trailing app name or a question
//   form is not a setting name).
// - Language: "speak Spanish", "talk to me in German", "switch to French", "use English",
//   "set your language to Dutch", "reply to me in Italian", and the same in the voice languages
//   ("habla inglés", "auf Englisch"). A bare "reply in French" is left to the model: it can be
//   a request to write an email reply in French.
// - "stop", "stop talking" and "be quiet" stay cancel words; muting is "mute your voice" /
//   "turn off spoken replies" / "don't read answers aloud".
// - Bare "dwell on/off" and "start/stop scanning" stay with the a11y grammar (pause / resume);
//   "turn on dwell clicking" here really turns the feature on.
import {
  ENGLISH_LANGUAGE_NAMES,
  LANGUAGE_WORDS,
  SETTINGS,
  type EnumRow,
  type NumberRow,
  type SettingRow
} from './table'

export type SettingsSection =
  | 'general'
  | 'voice'
  | 'accessibility'
  | 'look'
  | 'models'
  | 'usage'
  | 'memory'
  | 'lessons'
  | 'skills'
  | 'background'
  | 'buddies'
  | 'helpers'
  | 'bridges'
  | 'claude-code'
  | 'connectors'
  | 'news'
  | 'privacy'
  | 'diagnostics'
  | 'about'

export type SetOp =
  | { to: unknown }
  | { on: boolean }
  | { step: 1 | -1 }
  | { reset: true }
  | { number: number; percent: boolean }

export type SettingsCommand =
  | { kind: 'set'; id: string; op: SetOp }
  | { kind: 'query'; id: string }
  | { kind: 'open'; section: SettingsSection | null }
  | { kind: 'onboarding' }
  | { kind: 'update-check' }
  /** `scoped`: the words said Lumen; else claimed only while an update is ready. */
  | { kind: 'update-install'; scoped: boolean }
  /** `explicit`: "change your voice to …"; else an unknown name passes on. */
  | { kind: 'voice'; name: string; explicit: boolean }
  | { kind: 'voice-list' }
  | { kind: 'voice-query' }

export interface Normalized {
  text: string
  /** The words said Lumen ("in Lumen", "Lumen's", "your"). */
  scoped: boolean
}

const MAX_WORDS = 14

const LEAD =
  /^(?:(?:ok|okay|hey lumen|hi lumen|lumen|please|now|so|hey|can you|could you|would you|will you)\s+)+/
const TRAIL = /\s+(?:please|now|thanks|thank you|for me)$/

/** Lower case, no accents or punctuation, no leading "ok" / "please" / "hey Lumen". */
export function normalizeSettings(raw: string): Normalized {
  let t = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9.% ]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/%/g, ' percent')
    .replace(/\s+/g, ' ')
    .trim()
  for (let i = 0; i < 3; i++) t = t.replace(LEAD, '').replace(TRAIL, '').trim()
  const scoped = /\b(?:lumen|lumens|your|yourself)\b/.test(t)
  t = t
    .replace(/ (?:in|for|on|inside) (?:the )?lumens?(?: settings| app)?$/, '')
    .replace(/\blumens?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { text: t, scoped }
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(esc)
    .join('|')
const F = '(?:(?:the|my|your) )?'

// ---- per-row sentences ----

const ON_VERBS = '(?:turn on|switch on|enable|activate)'
const OFF_VERBS = '(?:turn off|switch off|disable|deactivate|dont use|do not use|no more)'
const NUMBER_RE = '(\\d+(?:\\.\\d+)?)(?: (percent|times|x))?'

interface BoolForms {
  on: RegExp
  off: RegExp
  start?: RegExp
  stop?: RegExp
  show?: RegExp
  hide?: RegExp
}

interface NumberForms {
  more: RegExp
  up: RegExp
  less: RegExp
  down: RegExp
  reset: RegExp
  to: RegExp
}

interface NameSet {
  needsScope: boolean
  query: RegExp[]
  bool?: BoolForms
  enumForms?: RegExp[]
  number?: NumberForms
}

interface Compiled {
  row: SettingRow
  /** Regexes over all names / the names that need Lumen in the words. */
  sets: NameSet[]
}

function queryForms(N: string): RegExp[] {
  return [
    new RegExp(`^(?:what is|whats|what s|tell me) (?:my|your) ${N}(?: set to| setting| now| at)?$`),
    new RegExp(`^(?:what is|whats|what s) (?:the )?${N} (?:set to|setting)$`),
    new RegExp(
      `^(?:is|are) ${F}${N} (?:on|off|enabled|disabled|turned on|turned off|active|switched on|switched off)$`
    )
  ]
}

function boolForms(row: SettingRow, N: string, multi: string): BoolForms {
  const forms: BoolForms = {
    on: new RegExp(`^${ON_VERBS} ${F}${N}$|^(?:turn|switch) ${F}${N} on$|^${F}${N} on$`),
    off: new RegExp(`^${OFF_VERBS} ${F}${N}$|^(?:turn|switch) ${F}${N} off$|^${F}${N} off$`)
  }
  if (multi) {
    const M = `(?:${multi})`
    forms.start = new RegExp(`^(?:start|start using) ${F}${M}$`)
    forms.stop = new RegExp(`^(?:stop|stop using) ${F}${M}$`)
  }
  if (row.visual) {
    forms.show = new RegExp(`^show ${F}${N}$`)
    forms.hide = new RegExp(`^hide ${F}${N}$|^(?:dont|stop) show(?:ing)? ${F}${N}$`)
  }
  return forms
}

function enumForms(row: EnumRow, N: string): RegExp[] {
  const V = alt(row.values.flatMap((v) => v.words))
  return [
    new RegExp(
      `^(?:set|change|switch|make|put) ${F}${N} (?:to|into) (?:the |a )?(${V})(?: ${N})?$`
    ),
    new RegExp(`^(?:use|switch to|change to|go to|pick|choose) (?:the |a )?(${V}) ${N}$`),
    new RegExp(`^make ${F}${N} (${V})$`)
  ]
}

function numberForms(row: NumberRow, N: string): NumberForms {
  const more = alt(row.more)
  const less = alt(row.less)
  const step = '(?:a (?:little |bit |lot )?)?'
  return {
    more: new RegExp(`^(?:make|turn) ${F}${N} ${step}(?:${more})$`),
    up: new RegExp(`^(?:increase|raise|turn up) ${F}${N}$|^${F}${N} up$`),
    less: new RegExp(`^(?:make|turn) ${F}${N} ${step}(?:${less})$`),
    down: new RegExp(`^(?:decrease|lower|reduce|turn down) ${F}${N}$|^${F}${N} down$`),
    reset: new RegExp(
      `^(?:reset|restore) ${F}${N}(?: to (?:normal|default))?$|^(?:set|put) ${F}${N} (?:back )?to (?:normal|default)$`
    ),
    to: new RegExp(`^(?:set|change|make|put) ${F}${N} to ${NUMBER_RE}$`)
  }
}

function compile(row: SettingRow): Compiled {
  const sets: NameSet[] = []
  const add = (names: string[], needsScope: boolean): void => {
    if (!names.length) return
    const multi = names.filter((n) => n.includes(' '))
    const N = `(?:${alt(names)})`
    const set: NameSet = { needsScope, query: queryForms(N) }
    if (row.kind === 'number') set.number = numberForms(row, N)
    else {
      if (row.kind === 'enum') set.enumForms = enumForms(row, N)
      set.bool = boolForms(row, N, multi.length ? alt(multi) : '')
    }
    sets.push(set)
  }
  add(row.names, row.scope === 'ambiguous')
  add(row.scopedNames ?? [], true)
  return { row, sets }
}

const COMPILED = SETTINGS.map(compile)

function boolOp(n: string, f: BoolForms): boolean | null {
  if (f.on.test(n)) return true
  if (f.off.test(n)) return false
  if (f.start?.test(n)) return true
  if (f.stop?.test(n)) return false
  if (f.show?.test(n)) return true
  if (f.hide?.test(n)) return false
  return null
}

function valueOf(row: EnumRow, said: string): EnumRow['values'][number] | undefined {
  return row.values.find((v) => v.words.includes(said))
}

function enumOp(n: string, row: EnumRow, forms: RegExp[]): SetOp | null {
  for (const re of forms) {
    const m = re.exec(n)
    const v = m && valueOf(row, m[1])
    if (v) return { to: v.value }
  }
  return null
}

function numberOp(n: string, f: NumberForms): SetOp | null {
  if (f.more.test(n) || f.up.test(n)) return { step: 1 }
  if (f.less.test(n) || f.down.test(n)) return { step: -1 }
  if (f.reset.test(n)) return { reset: true }
  const m = f.to.exec(n)
  if (m) return { number: Number(m[1]), percent: m[2] === 'percent' }
  return null
}

function rowCommand(n: string, scoped: boolean, c: Compiled): SettingsCommand | null {
  const { row } = c
  for (const p of row.phrases ?? []) {
    if (!p.re.test(n)) continue
    if (row.scope === 'ambiguous' && !scoped && !p.free) return null
    return { kind: 'set', id: row.id, op: { to: p.to } }
  }
  if (row.kind === 'number') {
    const phrase = (list: RegExp[] | undefined): boolean => !!list?.some((re) => re.test(n))
    const ok = row.scope === 'lumen' || scoped
    if (ok && phrase(row.morePhrases)) return { kind: 'set', id: row.id, op: { step: 1 } }
    if (ok && phrase(row.lessPhrases)) return { kind: 'set', id: row.id, op: { step: -1 } }
    if (ok && phrase(row.resetPhrases)) return { kind: 'set', id: row.id, op: { reset: true } }
  }
  for (const s of c.sets) {
    if (s.needsScope && !scoped) continue
    if (row.queries?.some((re) => re.test(n)) || s.query.some((re) => re.test(n)))
      return { kind: 'query', id: row.id }
    if (s.number) {
      const op = numberOp(n, s.number)
      if (op) return { kind: 'set', id: row.id, op }
      continue
    }
    if (row.kind === 'enum' && s.enumForms) {
      const op = enumOp(n, row, s.enumForms)
      if (op) return { kind: 'set', id: row.id, op }
      if (row.onValue === undefined) continue
    }
    const on = s.bool ? boolOp(n, s.bool) : null
    if (on !== null) return { kind: 'set', id: row.id, op: { on } }
  }
  return null
}

// ---- language ----

const LANG_OF = new Map<string, string>()
for (const [code, l] of Object.entries(LANGUAGE_WORDS))
  for (const w of l.words) LANG_OF.set(w, code)
const L = `(${alt([...LANG_OF.keys()])})`

const EN_LANGUAGE_FORMS = [
  new RegExp(`^(?:lets )?(?:speak|talk)(?: to me)?(?: in)? ${L}(?: to me)?(?: from now on)?$`),
  new RegExp(`^(?:reply|answer|respond)(?: to me| me) in ${L}(?: from now on)?$`),
  new RegExp(`^(?:always|from now on) (?:reply|answer|respond|speak|talk)(?: to me)? in ${L}$`),
  new RegExp(`^(?:switch|change)(?: over)? (?:to|into) ${L}$`),
  new RegExp(`^use ${L}$`),
  new RegExp(`^(?:set|change|switch) ${F}(?:voice |spoken |reply )?language to ${L}$`)
]

// The same request said in the voice languages (once Lumen listens in Spanish, "speak English"
// may be heard as "habla inglés").
const FOREIGN_VERBS = alt([
  'habla',
  'hablame',
  'hablemos',
  'hablar',
  'responde',
  'respondeme',
  'contesta',
  'contestame',
  'cambia a',
  'sprich',
  'sprich mit mir',
  'antworte',
  'antworte mir',
  'wechsle zu',
  'wechsle auf',
  'parle',
  'parlez',
  'parle moi',
  'parlons',
  'reponds',
  'repondez',
  'passe en',
  'parla',
  'parlami',
  'rispondi',
  'rispondimi',
  'passa a',
  'fala',
  'fale',
  'falar',
  'responda',
  'muda para',
  'spreek',
  'praat',
  'antwoord',
  'schakel over naar'
])
const FOREIGN_PREPS = alt(['en', 'em', 'in het', 'in', 'auf', 'au', 'al', 'a', 'op', 'naar'])
const FOREIGN_FORMS = [
  new RegExp(`^(?:${FOREIGN_VERBS})(?: (?:${FOREIGN_PREPS}))? ${L}$`),
  new RegExp(`^(?:${FOREIGN_PREPS}) ${L}$`)
]

function languageCommand(n: string): SettingsCommand | null {
  if (/^(?:detect|figure out|guess|work out) (?:my|the) language(?: automatically)?$/.test(n))
    return { kind: 'set', id: 'language', op: { to: 'auto' } }
  for (const re of EN_LANGUAGE_FORMS) {
    const m = re.exec(n)
    if (m && ENGLISH_LANGUAGE_NAMES.has(m[1]))
      return { kind: 'set', id: 'language', op: { to: LANG_OF.get(m[1]) } }
  }
  for (const re of FOREIGN_FORMS) {
    const m = re.exec(n)
    if (m && !ENGLISH_LANGUAGE_NAMES.has(m[1]))
      return { kind: 'set', id: 'language', op: { to: LANG_OF.get(m[1]) } }
  }
  return null
}

// ---- voices ----

/** Words that name a Windows voice feature, not a voice ("use voice typing", "voice access"). */
const NOT_A_VOICE = new Set([
  'typing',
  'access',
  'control',
  'commands',
  'command',
  'recorder',
  'recording',
  'mode',
  'search',
  'assistant',
  'chat',
  'input',
  'dictation',
  'notes',
  'note',
  'memo',
  'message',
  'mail',
  'call',
  'over',
  'effects',
  'changer',
  'your',
  'my',
  'this',
  'that',
  'spoken'
])

const VOICE_NAME = '([a-z]+(?: [a-z]+){0,2})'
const VOICE_EXPLICIT_RE = new RegExp(
  `^(?:change|set|switch) (?:your|the) voice to (?:the |a )?${VOICE_NAME}(?: voice)?$`
)
const VOICE_PLAIN_RE = new RegExp(
  `^(?:use|switch to|change to|try|pick) (?:the )?voice ${VOICE_NAME}$`
)
const VOICE_NAME_FIRST_RE = new RegExp(
  `^(?:use|switch to|change to|try|pick) (?:the |a )?${VOICE_NAME} voice$`
)

function voiceCommand(n: string): SettingsCommand | null {
  if (
    /^(?:what|which) voices (?:do you have|are there|can you use|are available|can i (?:use|pick|choose))$/.test(
      n
    ) ||
    /^list (?:your |the )?voices$/.test(n)
  )
    return { kind: 'voice-list' }
  if (
    /^(?:what|which) voice (?:is this|is that|are you using|do you use|is on)$/.test(n) ||
    /^(?:whats|what is) your voice(?: called)?$/.test(n)
  )
    return { kind: 'voice-query' }
  const gender =
    /^(?:use|switch to|change to|try|pick) (?:a |the )?(male|female|man|woman|mans|womans|man s|woman s) voice$/.exec(
      n
    )
  if (gender)
    return {
      kind: 'voice',
      name: /^(?:female|woman)/.test(gender[1]) ? 'female' : 'male',
      explicit: true
    }
  const explicit = VOICE_EXPLICIT_RE.exec(n)
  const plain = VOICE_PLAIN_RE.exec(n) ?? VOICE_NAME_FIRST_RE.exec(n)
  const m = explicit ?? plain
  if (!m) return null
  const name = m[1]
  if (name.split(' ').some((w) => NOT_A_VOICE.has(w))) return null
  if (/^(?:different|another|other|next|new)$/.test(name))
    return { kind: 'voice', name: 'next', explicit: true }
  return { kind: 'voice', name, explicit: !!explicit }
}

// ---- Settings pages, setup, updates ----

/** Spoken page names → section; `scoped`: Windows Settings has a page of that name too. */
const SECTION_ALIASES: [string, SettingsSection, boolean][] = [
  ['general', 'general', true],
  ['hotkey', 'general', false],
  ['push to talk', 'general', false],
  ['voice', 'voice', false],
  ['wake word', 'voice', false],
  ['spoken replies', 'voice', false],
  ['microphone', 'voice', true],
  ['mic', 'voice', true],
  ['speech', 'voice', true],
  // Lumen's own audience: "accessibility settings" means Lumen's; Windows' are "Windows
  // accessibility settings", which never matches.
  ['accessibility', 'accessibility', false],
  ['dwell', 'accessibility', false],
  ['dwell clicking', 'accessibility', false],
  ['switch access', 'accessibility', false],
  ['face gestures', 'accessibility', false],
  ['head pointer', 'accessibility', false],
  ['captions', 'accessibility', true],
  ['ease of access', 'accessibility', true],
  ['look', 'look', false],
  ['buddy and look', 'look', false],
  ['buddy', 'look', false],
  ['appearance', 'look', true],
  ['theme', 'look', true],
  ['colour', 'look', true],
  ['color', 'look', true],
  ['models', 'models', false],
  ['models and keys', 'models', false],
  ['ai models', 'models', false],
  ['api keys', 'models', false],
  ['keys', 'models', true],
  ['usage', 'usage', false],
  ['cost', 'usage', false],
  ['spending', 'usage', false],
  ['memory', 'memory', false],
  ['lessons', 'lessons', false],
  ['lesson', 'lessons', false],
  ['skills', 'skills', false],
  ['skill', 'skills', false],
  ['automations', 'background', false],
  ['automation', 'background', false],
  ['routines', 'background', false],
  ['background tasks', 'background', false],
  ['buddies', 'buddies', false],
  ['smart helpers', 'helpers', false],
  ['helpers', 'helpers', false],
  ['app helpers', 'bridges', false],
  ['bridges', 'bridges', false],
  ['connectors', 'connectors', false],
  ['integrations', 'connectors', true],
  ['news and reading', 'news', false],
  ['news', 'news', true],
  ['claude code', 'claude-code', false],
  ['privacy', 'privacy', true],
  ['diagnostics', 'diagnostics', true],
  ['about', 'about', true]
]

const OPEN = '(?:open|show|show me|go to|take me to|bring up|pull up|display)'
const PAGE = '(?:settings|setting|section|page|options|preferences)'
const SECTION_RE = alt(SECTION_ALIASES.map((a) => a[0]))
const OPEN_PAGE_RE = new RegExp(`^${OPEN} ${F}(${SECTION_RE}) ${PAGE}$`)
const OPEN_SETTINGS_FOR_RE = new RegExp(
  `^${OPEN} (?:the )?(?:settings|options|preferences) (?:for|on|about) (?:the )?(${SECTION_RE})$`
)
const OPEN_SETTINGS_RE = new RegExp(`^${OPEN} ${F}(?:settings|options|preferences)$`)

function openCommand(n: string, scoped: boolean): SettingsCommand | null {
  const m = OPEN_PAGE_RE.exec(n) ?? OPEN_SETTINGS_FOR_RE.exec(n)
  if (m) {
    const hit = SECTION_ALIASES.find((a) => a[0] === m[1])
    if (!hit || (hit[2] && !scoped)) return null
    return { kind: 'open', section: hit[1] }
  }
  if (scoped && OPEN_SETTINGS_RE.test(n)) return { kind: 'open', section: null }
  return null
}

const ONBOARDING = [
  /^(?:start|run|do|open|go through) (?:the )?setup again$/,
  /^(?:redo|restart|rerun|re do|re run) (?:the )?(?:setup|onboarding)$/,
  /^(?:start|run|show|open) (?:the )?onboarding(?: again)?$/,
  /^show me around$/,
  /^give me (?:a|the) tour$/,
  /^(?:take|walk) me through (?:the )?setup(?: again)?$/
]

function updateCommand(n: string, scoped: boolean): SettingsCommand | null {
  if (/^are you up to date$/.test(n)) return { kind: 'update-check' }
  if (
    scoped &&
    (/^(?:check|look) for (?:updates|an update|new versions?|a new version)$/.test(n) ||
      /^(?:is there|are there) (?:an update|updates|a new version)(?: available)?(?: for you)?$/.test(
        n
      ) ||
      /^update(?: yourself)?$/.test(n))
  )
    return { kind: 'update-check' }
  if (
    /^(?:restart|reboot) (?:to|and) (?:update|install (?:the )?update)$/.test(n) ||
    /^install (?:the |your )?update$/.test(n)
  )
    return { kind: 'update-install', scoped }
  return null
}

/** The settings command a whole utterance gives, or null. */
export function parseSettingsCommand(raw: string): SettingsCommand | null {
  const { text: n, scoped } = normalizeSettings(raw)
  if (!n || n.split(' ').length > MAX_WORDS) return null
  if (ONBOARDING.some((re) => re.test(n))) return { kind: 'onboarding' }
  const special = openCommand(n, scoped) ?? updateCommand(n, scoped) ?? voiceCommand(n)
  if (special) return special
  const lang = languageCommand(n)
  if (lang) return lang
  for (const c of COMPILED) {
    const cmd = rowCommand(n, scoped, c)
    if (cmd) return cmd
  }
  return null
}
