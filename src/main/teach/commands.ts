// Lesson voice commands (plans 07 T16). Only consulted while a lesson runs (or a resume offer
// is up), and only a whole utterance counts: "next" advances, "go back to gmail" is a normal
// request. Normalization is 06's (lowercase, punctuation and fillers like "please" dropped).
import { normalize } from '../a11y/voice-commands'
import type { LessonCommand } from './state'

const PHRASES: Record<LessonCommand, string[]> = {
  next: [
    'next',
    'next step',
    'continue',
    'go on',
    'keep going',
    'move on',
    'begin',
    'lets go',
    'lets start',
    'start'
  ],
  back: [
    'back',
    'go back',
    'previous',
    'previous step',
    'last step',
    'step back',
    'go back a step'
  ],
  repeat: [
    'repeat',
    'repeat that',
    'repeat the step',
    'say that again',
    'say it again',
    'again',
    'what was that',
    'come again',
    'pardon'
  ],
  skip: [
    'skip',
    'skip it',
    'skip this',
    'skip that',
    'skip step',
    'skip this step',
    'skip the step'
  ],
  stop: [
    'stop lesson',
    'stop the lesson',
    'end lesson',
    'end the lesson',
    'quit lesson',
    'quit the lesson',
    'exit lesson',
    'cancel lesson',
    'cancel the lesson',
    'stop teaching'
  ],
  pause: [
    'pause',
    'pause lesson',
    'pause the lesson',
    'wait',
    'hold on',
    'one moment',
    'give me a moment',
    'give me a minute'
  ],
  resume: [
    'resume',
    'resume lesson',
    'resume the lesson',
    'continue lesson',
    'continue the lesson',
    'carry on',
    'im back',
    'i am back',
    'im ready',
    'i am ready'
  ],
  help: [
    'help',
    'help me',
    'im stuck',
    'i am stuck',
    'stuck',
    'hint',
    'give me a hint',
    'i need help',
    'i need a hint',
    'i dont get it',
    'i dont understand',
    'show me'
  ],
  'do-it': [
    'do it for me',
    'do it',
    'you do it',
    'do this for me',
    'do this step for me',
    'do the step for me',
    'just do it',
    'do it yourself'
  ],
  why: [
    'why',
    'why this',
    'why do i do this',
    'why do i need this',
    'why do i need to do this',
    'whats this for',
    'what is this for',
    'what for'
  ],
  done: [
    'done',
    'i did it',
    'did it',
    'finished',
    'im done',
    'i am done',
    'ive done it',
    'i have done it',
    'all done',
    'got it',
    'i got it'
  ],
  slower: ['slower', 'slow down', 'more time', 'go slower', 'give me more time'],
  faster: ['faster', 'speed up', 'go faster', 'quicker', 'less time'],
  yes: ['yes', 'yeah', 'yep', 'yes please', 'sure', 'ok', 'okay', 'go ahead'],
  no: ['no', 'nope', 'no thanks', 'no thank you', 'not now', 'ill try', 'i will try', 'let me try'],
  perform: [
    'click it',
    'click that',
    'click this',
    'press it',
    'press that',
    'press this',
    'select it',
    'select that',
    'open it',
    'tap it',
    'toggle it'
  ]
}

const TABLE = new Map<string, LessonCommand>()
for (const [cmd, phrases] of Object.entries(PHRASES) as [LessonCommand, string[]][])
  for (const p of phrases) {
    // Keyed the way utterances are normalized ("not now" → "not", "ok" → "").
    const key = normalize(p)
    if (key && !TABLE.has(key)) TABLE.set(key, cmd)
  }

const MAX_CHARS = 60

/** The lesson command a whole utterance is, or null. */
export function parseLessonCommand(utterance: string): LessonCommand | null {
  if (!utterance || utterance.length > MAX_CHARS) return null
  const norm = normalize(utterance)
  if (norm) return TABLE.get(norm) ?? null
  // normalize() strips "ok"/"okay" as fillers; on their own they mean yes.
  const bare = utterance.toLowerCase().replace(/[^a-z]/g, '')
  return bare === 'ok' || bare === 'okay' ? 'yes' : null
}

/** Phrases per command, for the help sheet. */
export function lessonPhrases(): Record<LessonCommand, readonly string[]> {
  return PHRASES
}

const START_RES = [
  /^(?:start|begin|open|play|run)(?: the)?(?: lesson| tutorial)(?: called| named)? (?<q>.+)$/,
  /^teach me(?: how to| to| about)? (?<q>.+)$/
]

/** "start lesson make a folder", "teach me blender" → the words to look for; else null. */
export function matchStartLesson(utterance: string): string | null {
  if (!utterance || utterance.length > 120) return null
  const norm = normalize(utterance)
  for (const re of START_RES) {
    const q = re.exec(norm)?.groups?.q?.trim()
    if (q) return q
  }
  return null
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'in',
  'how',
  'my',
  'and',
  'of',
  'with',
  'for',
  'on',
  'basics'
])
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))

export interface LessonCandidate {
  id: string
  title: string
  appId: string
  appName: string
}

/**
 * The lesson a spoken query names. An app name alone ("blender") picks that app's first
 * lesson; otherwise the title sharing the most words wins (at least half the query words).
 */
export function pickLesson(query: string, lessons: LessonCandidate[]): LessonCandidate | null {
  const q = words(query)
  if (!q.length) return null
  const appOnly = lessons.filter((l) => {
    const app = words(`${l.appName} ${l.appId}`)
    return q.every((w) => app.includes(w))
  })
  if (appOnly.length) return [...appOnly].sort((a, b) => a.id.localeCompare(b.id))[0]
  let best: LessonCandidate | null = null
  let bestScore = 0
  for (const l of lessons) {
    const t = new Set([...words(l.title), ...words(l.appName), ...words(l.appId)])
    const score = q.filter((w) => t.has(w)).length
    if (score > bestScore) {
      best = l
      bestScore = score
    }
  }
  return best && bestScore * 2 >= q.length ? best : null
}

const SAVE_RE =
  /^(?:please\s+)?(?:save|keep|remember)\s+(?:this|that|the)?\s*(?:lesson|guide)(?:\s+as\s+(?<name>.{1,60}?))?[\s.!?]*$/i

/** "save this lesson", "save guide as compose" → { name? }; else null. */
export function matchSaveLesson(utterance: string): { name?: string } | null {
  const m = SAVE_RE.exec((utterance ?? '').trim())
  if (!m) return null
  const name = m.groups?.name?.replace(/[.!?,;:]+$/, '').trim()
  return name ? { name } : {}
}

/** The app a query names on its own ("blender", "the windows basics"), else null. */
export function matchAppOnly(query: string, apps: { id: string; name: string }[]): string | null {
  const q = words(query)
  if (!q.length) return null
  const hit = apps.find((a) => {
    const w = words(`${a.name} ${a.id.replace(/-/g, ' ')}`)
    return q.every((x) => w.includes(x))
  })
  return hit?.id ?? null
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
}

/** "2", "two", "number 2", "the second one" → 2; else null. */
export function lessonNumber(query: string): number | null {
  const w = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x && x !== 'number' && x !== 'the' && x !== 'lesson')
  if (w.length === 2 && w[1] === 'one') w.pop()
  if (w.length !== 1) return null
  const n = /^\d+$/.test(w[0]) ? Number(w[0]) : (NUMBER_WORDS[w[0]] ?? 0)
  return n > 0 && n <= 50 ? n : null
}

const NEXT_RES = [
  /^what (?:should|can|do) i (?:learn|study|try|do) next(?: (?:in|for|with) (?<app>.+))?$/,
  /^what (?:should|can|do) i (?:learn|study|try) (?:in|for|with) (?<app>.+?) next$/,
  /^(?:whats|what is) (?:my )?next lesson(?: (?:in|for) (?<app>.+))?$/,
  /^(?:suggest|recommend) (?:a|my next|the next) lesson(?: (?:in|for) (?<app>.+))?$/
]

/** "what should I learn next in Blender?" → { app: 'blender' }; no app named → {}. */
export function matchLearnNext(utterance: string): { app?: string } | null {
  if (!utterance || utterance.length > 120) return null
  const norm = normalize(utterance)
  for (const re of NEXT_RES) {
    const m = re.exec(norm)
    if (m) {
      const app = m.groups?.app?.trim()
      return app ? { app } : {}
    }
  }
  return null
}

const START_IT = new Set(
  [
    'start it',
    'start the lesson',
    'start the review',
    'start review',
    'review',
    'review it',
    'lets review',
    'do the review',
    'do the lesson',
    'quick review',
    'lets do it'
  ].map(normalize)
)

/** "start it" / "review" — takes a suggested lesson or a review prompt. */
export function matchStartIt(utterance: string): boolean {
  return utterance.length <= 40 && START_IT.has(normalize(utterance))
}

const STOP_REMINDING =
  /^(?:stop|no more|dont|do not|never)(?: (?:the|review|lesson))* remind(?:ing|ers?)?(?: me)?(?: (?:about|of) (?:reviews?|lessons?))?$/

/** "stop reminding me", "no more reminders", "don't remind me about reviews". */
export function matchStopReminding(utterance: string): boolean {
  return utterance.length <= 60 && STOP_REMINDING.test(normalize(utterance))
}

const COACH_ON =
  /^(?:(?:turn on|start|enable) coach(?:ing)?(?: mode)?|coach mode(?: on)?|coach me)$/
const COACH_OFF = /^(?:(?:turn off|stop|end|disable) coach(?:ing)?(?: mode)?|coach mode off)$/

/** "coach mode on" → true, "stop coaching" → false, else null (T33). */
export function matchCoach(utterance: string): boolean | null {
  if (!utterance || utterance.length > 40) return null
  const norm = normalize(utterance)
  if (COACH_ON.test(norm)) return true
  if (COACH_OFF.test(norm)) return false
  return null
}

// ---- Record my steps (T31) ----

const RECORD_START =
  /^(?:watch me|record (?:me|my steps)|start recording my steps|learn from me)(?: (?:do|doing|while i|how to|how i))?(?: (?<title>.+))?$/
const VAGUE_TITLE = new Set(['this', 'it', 'that', 'something', 'do this', 'do it', 'now'])

/** "watch me do this", "watch me turn on dark mode" → { title? }; else null. */
export function matchRecordStart(utterance: string): { title?: string } | null {
  if (!utterance || utterance.length > 120) return null
  const m = RECORD_START.exec(normalize(utterance))
  if (!m) return null
  const title = m.groups?.title?.trim()
  return title && !VAGUE_TITLE.has(title) ? { title } : {}
}

const RECORDING_PHRASES: Record<'stop' | 'cancel' | 'shot', string[]> = {
  stop: [
    'stop recording',
    'stop watching',
    'done recording',
    'finish recording',
    'end recording',
    'im done',
    'i am done',
    'thats it',
    'that is it',
    'done',
    'stop',
    'finished',
    'all done'
  ],
  cancel: [
    'cancel recording',
    'cancel the recording',
    'discard recording',
    'discard the recording',
    'forget it',
    'never mind',
    'cancel'
  ],
  shot: [
    'screenshot',
    'take a screenshot',
    'take screenshot',
    'capture this',
    'capture this step',
    'capture the screen',
    'snapshot',
    'take a snapshot',
    'take a picture',
    'remember this screen'
  ]
}

const DRAFT_PHRASES: Record<'read' | 'play' | 'discard', string[]> = {
  read: [
    'read it back',
    'read it',
    'read the steps',
    'read back the steps',
    'read me the steps',
    'what did you write',
    'what are the steps'
  ],
  play: ['try it', 'play it', 'test it', 'try the lesson', 'play the draft', 'try the draft'],
  discard: [
    'discard it',
    'discard the draft',
    'delete it',
    'delete the draft',
    'throw it away',
    'forget it',
    "don't save it",
    'do not save it'
  ]
}

/** Also the cancel words of running work (query/drafts decides). */
const BARE_DISCARD = new Set(['forget it'].map(normalize))

function phraseTable<K extends string>(t: Record<K, string[]>): Map<string, K> {
  const m = new Map<string, K>()
  for (const [k, list] of Object.entries(t) as [K, string[]][])
    for (const p of list) if (!m.has(normalize(p))) m.set(normalize(p), k)
  return m
}
const RECORDING_TABLE = phraseTable(RECORDING_PHRASES)
const DRAFT_TABLE = phraseTable(DRAFT_PHRASES)

/** While recording: "stop recording" / "cancel recording" / "take a screenshot". */
export function matchRecordingCommand(utterance: string): 'stop' | 'cancel' | 'shot' | null {
  if (!utterance || utterance.length > 60) return null
  return RECORDING_TABLE.get(normalize(utterance)) ?? null
}

const SAVE_DRAFT_RE =
  /^(?:please\s+)?(?:save|keep)\s+(?:it|this|that|the draft|the lesson|this lesson|my steps|the recording)(?:\s+as\s+(?<name>.{1,80}?))?[\s.!?]*$/i

/** Reviewing a draft: "save it as dark mode", "read it back", "try it", "discard it". */
export function matchDraftCommand(
  utterance: string
):
  | { cmd: 'save'; name?: string }
  | { cmd: 'read' | 'play' }
  | { cmd: 'discard'; bare?: true }
  | null {
  if (!utterance || utterance.length > 120) return null
  const save = SAVE_DRAFT_RE.exec(utterance.trim())
  if (save) {
    const name = save.groups?.name?.replace(/[.!?,;:]+$/, '').trim()
    return name ? { cmd: 'save', name } : { cmd: 'save' }
  }
  const n = normalize(utterance)
  const cmd = DRAFT_TABLE.get(n)
  if (cmd === 'discard' && BARE_DISCARD.has(n)) return { cmd, bare: true }
  return cmd ? { cmd } : null
}
