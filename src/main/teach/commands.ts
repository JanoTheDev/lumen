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
