// Where one final transcript goes, first match wins. This is the pure decision, built from the
// same matchers the app runs:
//   1. empty                → nothing ("Didn't catch that")
//   2. a confirm is waiting → yes / no / always, in the voice language (stop counts as no)
//   3. a lesson runs        → lesson word, whole utterance only (07 parseLessonCommand)
//   4. 06's local grammar   → executed locally, no word minimum ("click 5", "scroll down")
//   5. voice cancel         → a whole-utterance stop word at any time; "stop, …" at the start
//                             only while something acts. Word boundaries ("stopwatch" is not)
//   6. everything else      → the query pipeline, with the voice language
//
// The live order (ipc/query.ts `assistant:query`, then the intercept chain in index.ts, then
// pipeline.ts runTurn) has more steps around these:
//   a. router-hook prepareVoiceText: other languages' short answers, "stop, …" while acting
//   b. agent-mode answerAlways: "always" on a grantable policy confirm
//   c. agent-mode interceptAgentUtterance while a foreground task runs: stop words first,
//      else the answer to its ask_user question; "keep going" on its own "Keep going?" card;
//      go / stop / wait during the countdown; stop, wait / pause, resume while it runs
//   d. a11y beforeUtterance: yes / no on a waiting confirm (anything else drops the card),
//      caption corrections
//   e. intercept chain: interceptClaudeCode (with coding-skill draft review), interceptStyles
//      (style draft review), interceptAgentMode (skill making and draft review, task chat,
//      "what did you do"), interceptRoutines, interceptFace, interceptHelpers,
//      interceptDeictic, interceptDocs, interceptLabels, interceptLocal (teach interceptLesson
//      with the recorded-lesson draft review, an ambiguous skill trigger, 06's grammar, then
//      prefilter guide / memory / cancel words). Draft review words go only to the newest
//      waiting draft, and bare "no" / "cancel" / "forget it" discard one only while nothing
//      runs (query/drafts)
//   f. a running agent task asks before a new request replaces it
//   g. the request queue: preempt (a pointed-at file shared, auto-detected dictation), then
//      runTurn: "resume the task", usage questions, buddies (draft review, making, calling),
//      answer-card follow-ups, read-the-web, "in the background …" / skill triggers, then
//      the router (or legacy planner) and the model, show me how, agent-mode tasks
import type { VoiceLanguage } from '@shared/config'
import {
  IDLE_CONTEXT,
  parseCommand,
  type Command,
  type CommandContext
} from '../a11y/voice-commands'
import { parseLessonCommand } from '../teach/commands'
import type { LessonCommand } from '../teach/state'
import { canonicalUtterance, foldText, lexiconLangs, matchConfirm, phrases } from './lexicon'
import type { ConfirmWord, Lang } from './lexicon'

export type VoiceRoute =
  | { kind: 'empty' }
  | { kind: 'confirm'; answer: ConfirmWord }
  | { kind: 'lesson'; command: LessonCommand }
  | { kind: 'local'; command: Command }
  | { kind: 'cancel'; rest?: string }
  | { kind: 'query'; text: string; lang: VoiceLanguage }

export interface RouteState {
  confirmPending: boolean
  lessonRunning: boolean
  /** An action, plan or spoken answer is running: "stop, …" at the start cancels it. */
  busy: boolean
  /** 06 grammar gates (numbers shown, guide active, …). */
  commands?: CommandContext
  /** Whether 06's grammar is on (a11y.voiceCommands). */
  grammar?: boolean
  lang?: VoiceLanguage
}

const MIN_REST_WORDS = 2

function stopPrefixRe(langs: Lang[]): RegExp {
  const list = langs
    .flatMap((l) => phrases(l, 'stop'))
    .map(foldText)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/\s+/g, '\\s+'))
  return new RegExp(`^(?:${list.join('|')})(?=\\s|$)\\s*(.*)$`)
}

const PREFIX_RES = new Map<string, RegExp>()

/**
 * "stop, open notepad" → { rest: "open notepad" }; "stop" → { rest: "" }; "stopwatch" → null.
 * The start must be a stop phrase followed by a pause mark or the end, so "stop the music"
 * stays a request; "stop. open notepad" and "cancel that, open notepad" cancel.
 */
export function leadingStop(text: string, lang?: VoiceLanguage): { rest: string } | null {
  const langs = lexiconLangs(lang)
  const key = langs.join(',')
  let re = PREFIX_RES.get(key)
  if (!re) PREFIX_RES.set(key, (re = stopPrefixRe(langs)))
  // A pause mark right after the phrase tells "stop, open X" from "stop the music".
  const raw = text.trim()
  const folded = foldText(raw)
  const m = re.exec(folded)
  if (!m) return null
  const rest = m[1].trim()
  if (!rest) return { rest: '' }
  const head = folded.slice(0, folded.length - m[1].length).trim()
  const headWords = head.split(' ').length
  // Position in the raw text after the same number of words, then require , . ! ; : or -.
  const words = raw.split(/\s+/)
  const pause = /[,.!;:\-—]$/
  if (pause.test(words[headWords - 1] ?? '')) return { rest: words.slice(headWords).join(' ') }
  // "never mind - open mail": the pause mark stands alone.
  if (/^[,.!;:\-—]+$/.test(words[headWords] ?? ''))
    return { rest: words.slice(headWords + 1).join(' ') }
  return null
}

export function routeUtterance(text: string, state: RouteState): VoiceRoute {
  const lang = state.lang ?? 'en'
  const trimmed = text.trim()
  if (!foldText(trimmed)) return { kind: 'empty' }

  if (state.confirmPending) {
    const answer = matchConfirm(trimmed, lang)
    if (answer) return { kind: 'confirm', answer }
  }

  // Lesson and grammar matchers are English; other languages' short words map onto them.
  const english = canonicalUtterance(trimmed, lang)
  if (state.lessonRunning) {
    const command = parseLessonCommand(english)
    if (command) return { kind: 'lesson', command }
  }

  if (state.grammar !== false) {
    const command = parseCommand(english, state.commands ?? IDLE_CONTEXT)
    if (command) return { kind: 'local', command }
  }

  const stop = leadingStop(trimmed, lang)
  if (stop && !stop.rest) return { kind: 'cancel' }
  if (stop && state.busy && stop.rest.split(/\s+/).length >= MIN_REST_WORDS)
    return { kind: 'cancel', rest: stop.rest }

  return { kind: 'query', text: trimmed, lang }
}
