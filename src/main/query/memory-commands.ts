// Spoken conversation/memory commands, matched as whole utterances by the router prefilter
// until 06's grammar takes them over. Each one is handled locally and confirmed through the
// answer path (card + speech); none of them reaches the model.
import type { ModelResponse } from '@shared/types'
import { matchSaveGuide, normalizeUtterance } from '../guides/voice-nav'
import { addToHistory, history } from '../ai/history'
import { endSession, memory } from '../ai/memory/runtime'
import { classifyProfileFact } from '../ai/memory/profile'
import type { Episode } from '../ai/memory'
import type { ConfigPatch } from '@shared/config'
import { loadConfig, saveConfig } from '../config'
import { log } from '../logger'

export type MemoryWhen = 'yesterday' | 'today' | 'last-week' | 'last-time'

export type MemoryCommand =
  | { kind: 'new-topic' }
  | { kind: 'forget-last' }
  | { kind: 'remember'; fact: string; section?: string }
  | { kind: 'forget-about'; topic: string }
  | { kind: 'recall-profile' }
  | { kind: 'private'; on: boolean }
  | { kind: 'continue' }
  | { kind: 'last-time'; when: MemoryWhen; app?: string }

const MAX_FACT_CHARS = 200

const NEW_TOPIC_RE = /^(new topic|start over|change (the )?subject|lets start over)$/
const FORGET_LAST_RE = /^(forget (that|what i (just )?said)|scratch that)$/
const FORGET_ABOUT_RE = /^forget (?:everything )?about (.{2,60})$/
const RECALL_RE =
  /^(what do you (remember|know) about me|what have you learned about me|what do you remember)$/
const PRIVATE_ON_RE =
  /^(private mode( on)?|turn on private mode|go private|dont remember (this|that|any of this)|stop remembering)$/
const PRIVATE_OFF_RE =
  /^(private mode off|turn off private mode|(stop|exit|leave|end) private mode|start remembering)$/
const CONTINUE_RE =
  /^((lets )?(continue|pick up) where we left off|where were we|(lets )?continue (from )?last time)$/
const LAST_TIME_RE =
  /^what (?:did|have) we (?:do|done|work on|worked on)(?: (yesterday|today|earlier|last week|last time))?(?: (?:in|with|on) (.{2,40}))?$/

// Matched on the raw utterance (keeps the fact's case); optional wake words and "please".
const LEAD = String.raw`^(?:(?:hey|ok|okay)\s+lumen[,.!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+)?`
const REMEMBER_RE = new RegExp(`${LEAD}remember\\s+(?:that\\s+)?(.+?)[.!]?$`, 'i')
// A name is one to three words.
const NAME = String.raw`([\p{L}'’-]{1,30}(?: [\p{L}'’-]{1,30}){0,2})`
const NAME_RE = new RegExp(`${LEAD}(?:my name is|my name's|i'm called)\\s+${NAME}[.!]?$`, 'iu')
const CALL_ME_RE = new RegExp(`${LEAD}call me\\s+${NAME}[.!]?$`, 'iu')

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function thirdPerson(verb: string): string {
  const v = verb.toLowerCase()
  if (v === 'have') return 'has'
  if (v === 'am') return 'is'
  if (/(s|sh|ch|x|z|o)$/.test(v)) return `${v}es`
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`
  return `${v}s`
}

/** "I'm left-handed" → "Is left-handed", "I use dwell" → "Uses dwell", "my X" → "X". */
export function factFromSpeech(text: string): string {
  let t = text.trim().replace(/\s+/g, ' ')
  t = t
    .replace(/^(?:i am|i'm)\s+/i, 'is ')
    .replace(/^i\s+(?:really\s+)?(\w+)\s+/i, (_m, verb: string) => `${thirdPerson(verb)} `)
    .replace(/^my\s+/i, '')
    .replace(/\bmy\b/gi, 'their')
  return capitalize(t)
}

/** The command an utterance is, or null. Only whole utterances match. */
export function matchMemoryCommand(utterance: string): MemoryCommand | null {
  const raw = utterance.trim()
  const text = normalizeUtterance(raw)
  if (!text) return null
  if (NEW_TOPIC_RE.test(text)) return { kind: 'new-topic' }
  if (FORGET_LAST_RE.test(text)) return { kind: 'forget-last' }
  if (RECALL_RE.test(text)) return { kind: 'recall-profile' }
  if (PRIVATE_ON_RE.test(text)) return { kind: 'private', on: true }
  if (PRIVATE_OFF_RE.test(text)) return { kind: 'private', on: false }
  if (CONTINUE_RE.test(text)) return { kind: 'continue' }
  const about = FORGET_ABOUT_RE.exec(text)
  if (about) return { kind: 'forget-about', topic: about[1].trim() }
  const last = LAST_TIME_RE.exec(text)
  if (last && (last[1] || last[2])) {
    const w = last[1] ?? 'last time'
    const when: MemoryWhen =
      w === 'yesterday'
        ? 'yesterday'
        : w === 'today' || w === 'earlier'
          ? 'today'
          : w === 'last week'
            ? 'last-week'
            : 'last-time'
    return { kind: 'last-time', when, ...(last[2] ? { app: last[2].trim() } : {}) }
  }
  if (raw.length > MAX_FACT_CHARS + 30 || raw.endsWith('?')) return null
  const name = NAME_RE.exec(raw)
  if (name)
    return { kind: 'remember', fact: `Name: ${capitalize(name[1].trim())}`, section: 'Name' }
  const callMe = CALL_ME_RE.exec(raw)
  if (callMe)
    return {
      kind: 'remember',
      fact: `Preferred name: ${capitalize(callMe[1].trim())}`,
      section: 'Name'
    }
  const remember = REMEMBER_RE.exec(raw)
  // "remember to …" is a reminder request and "remember this guide as …" saves a guide.
  if (remember && !/^to\s/i.test(remember[1]) && !matchSaveGuide(raw)) {
    const fact = factFromSpeech(remember[1])
    if (fact.length >= 3) return { kind: 'remember', fact }
  }
  return null
}

export const spokenAnswer = (text: string): Extract<ModelResponse, { mode: 'answer' }> => ({
  mode: 'answer',
  text,
  spoken: text
})

// ---- handlers ----

interface MemoryHooks {
  /**
   * Saves a config change made by voice (private mode). Wired to the settings patch path so
   * windows and config listeners see it; it must save synchronously before its first await.
   */
  patchConfig: (patch: ConfigPatch) => unknown
  /** Memory files changed (the Memory page and review chip refresh). */
  changed: () => void
}

const noHooks: MemoryHooks = { patchConfig: (p) => saveConfig(p), changed: () => {} }
let hooks = noHooks

export function setMemoryHooks(h: Partial<MemoryHooks>): void {
  hooks = { ...noHooks, ...h }
}

const FORGET_WINDOW_MS = 10 * 60_000
let lastRemembered: { fact: string; at: number } | null = null

const OFF_REPLY =
  "Memory is off, so I don't keep anything about you. You can turn it on in Settings, under Memory."
const PRIVATE_REPLY = "Private mode is on, so I won't save anything new."

function writeBlockedReply(): string | null {
  const s = loadConfig().memory
  if (!s.enabled) return OFF_REPLY
  if (s.privateMode) return PRIVATE_REPLY
  return null
}

function remember(fact: string, section?: string): string {
  const blocked = writeBlockedReply()
  if (blocked) return blocked
  const r = memory().remember(fact, {
    layer: 'profile',
    section: section ?? classifyProfileFact(fact)
  })
  if (r === 'rejected')
    return "I won't store that. It looks like a password or a number I shouldn't keep."
  if (r === 'disabled') return OFF_REPLY
  lastRemembered = { fact, at: Date.now() }
  return r === 'replaced' ? "Got it, I've updated that." : "Got it, I'll remember that."
}

function forgetLast(): string {
  if (lastRemembered && Date.now() - lastRemembered.at < FORGET_WINDOW_MS) {
    const { fact } = lastRemembered
    lastRemembered = null
    const n = memory().forget(fact)
    if (n) return "Okay, I've forgotten that."
  }
  return history.dropLast() ? "Okay, I'll ignore that." : 'There was nothing to forget.'
}

function forgetAbout(topic: string): string {
  const mem = memory()
  const needle = topic.toLowerCase()
  let n = mem.forget(topic)
  for (const e of mem.episodes.list()) {
    const text = `${e.title} ${e.summary} ${e.apps.join(' ')} ${e.openThreads.join(' ')}`
    if (text.toLowerCase().includes(needle) && mem.deleteEpisode(e.id)) n++
  }
  return n
    ? `Done. I forgot ${n} ${n === 1 ? 'thing' : 'things'} about ${topic}.`
    : `I didn't have anything saved about ${topic}.`
}

const MAX_RECALL_FACTS = 8

function recallProfile(): string {
  const mem = memory()
  const facts = mem.profile.facts()
  if (!facts.length) {
    if (!loadConfig().memory.enabled) return OFF_REPLY
    return 'I don\'t know much about you yet. You can say "remember that" followed by anything you want me to keep.'
  }
  const said = facts
    .slice(0, MAX_RECALL_FACTS)
    .map((f) => f.text.replace(/[.\s]+$/, ''))
    .join('. ')
  const more =
    facts.length > MAX_RECALL_FACTS ? ` And ${facts.length - MAX_RECALL_FACTS} more.` : ''
  return `Here's what I remember about you. ${said}.${more} You can see and edit all of it in Settings, under Memory.`
}

function setPrivate(on: boolean): string {
  const prev = loadConfig().memory.privateMode
  if (prev !== on) {
    void hooks.patchConfig({ memory: { privateMode: on } })
  }
  // Turns from this session are not summarized either way: they were said before (or during)
  // private mode.
  memory().session.clear()
  return on
    ? "Private mode is on. I won't remember anything from now on."
    : "Private mode is off. I'll remember things again."
}

const DAY_MS = 86_400_000
const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function relativeDay(iso: string, now: Date): string {
  const day = localDay(new Date(iso))
  if (day === localDay(now)) return 'Earlier today'
  if (day === localDay(new Date(now.getTime() - DAY_MS))) return 'Yesterday'
  const days = Math.round((now.getTime() - Date.parse(iso)) / DAY_MS)
  return days < 7
    ? `${days} days ago`
    : `On ${new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
}

/** First two sentences, for speaking. */
const brief = (s: string): string =>
  (s.match(/[^.!?]+[.!?]+/g) ?? [s])
    .slice(0, 2)
    .map((x) => x.trim())
    .join(' ')

function sayEpisode(e: Episode, now: Date): string {
  const open = e.openThreads.length ? ` Still open: ${e.openThreads.slice(0, 2).join('; ')}.` : ''
  const lesson = e.refs.find((r) => r.kind === 'lesson')
  const lessonLine = lesson ? ` You were on lesson ${lesson.value}.` : ''
  return `${relativeDay(e.date, now)}: ${e.title.replace(/[.\s]+$/, '')}. ${brief(e.summary)}${open}${lessonLine}`
}

function appMatches(e: Episode, app: string): boolean {
  const a = app.toLowerCase().replace(/^the /, '')
  return e.apps.some((x) => x.toLowerCase().includes(a) || a.includes(x.toLowerCase()))
}

/** Episodes for "what did we do yesterday / last time in Blender", newest first. */
export function episodesFor(
  episodes: Episode[],
  when: MemoryWhen,
  app: string | undefined,
  now: Date
): Episode[] {
  let list = app ? episodes.filter((e) => appMatches(e, app)) : episodes
  const today = localDay(now)
  const yesterday = localDay(new Date(now.getTime() - DAY_MS))
  if (when === 'yesterday') list = list.filter((e) => localDay(new Date(e.date)) === yesterday)
  else if (when === 'today') list = list.filter((e) => localDay(new Date(e.date)) === today)
  else if (when === 'last-week')
    list = list.filter((e) => now.getTime() - Date.parse(e.date) <= 7 * DAY_MS)
  else list = list.slice(0, 1)
  return list.slice(0, 2)
}

function lastTime(when: MemoryWhen, app?: string): string {
  const mem = memory()
  const now = mem.store.now()
  const all = mem.episodes.list()
  if (!all.length && !loadConfig().memory.enabled) return OFF_REPLY
  const found = episodesFor(all, when, app, now)
  if (!found.length) {
    const span =
      when === 'yesterday'
        ? 'from yesterday'
        : when === 'today'
          ? 'from today'
          : when === 'last-week'
            ? 'from the last week'
            : 'yet'
    return `I don't have anything saved${app ? ` about ${app}` : ''} ${span}.`
  }
  return found.map((e) => sayEpisode(e, now)).join(' ')
}

function continueWhereLeftOff(utterance: string): string {
  const mem = memory()
  const now = mem.store.now()
  const turns = mem.session.turns()
  let reply: string
  if (turns.length && !mem.session.isStale()) {
    const last = turns[turns.length - 1]
    reply = `We were just on: "${last.utterance}". Tell me what you'd like to do next.`
  } else {
    const episodes = mem.episodes.list()
    const e = episodes.find((x) => x.openThreads.length) ?? episodes[0]
    if (!e)
      return loadConfig().memory.enabled ? "I don't have a previous session saved yet." : OFF_REPLY
    reply = `${sayEpisode(e, now)} Want to pick that up?`
  }
  // The next request ("yes, do that") sees what was offered.
  addToHistory({ utterance, spoken: reply, mode: 'answer' })
  return reply
}

/** Runs a command and returns the reply for the renderer. */
export function handleMemoryCommand(cmd: MemoryCommand, utterance = ''): ModelResponse {
  log('plan', `memory command: ${cmd.kind}`)
  try {
    switch (cmd.kind) {
      case 'new-topic':
        history.clear()
        void endSession('new topic')
        return spokenAnswer('Okay, new topic.')
      case 'forget-last': {
        const reply = forgetLast()
        hooks.changed()
        return spokenAnswer(reply)
      }
      case 'remember': {
        const reply = remember(cmd.fact, cmd.section)
        hooks.changed()
        return spokenAnswer(reply)
      }
      case 'forget-about': {
        const reply = forgetAbout(cmd.topic)
        hooks.changed()
        return spokenAnswer(reply)
      }
      case 'recall-profile':
        return spokenAnswer(recallProfile())
      case 'private':
        return spokenAnswer(setPrivate(cmd.on))
      case 'continue':
        return spokenAnswer(continueWhereLeftOff(utterance))
      case 'last-time':
        return spokenAnswer(lastTime(cmd.when, cmd.app))
    }
  } catch (e) {
    log('fail', `memory command ${cmd.kind} failed: ${(e as Error).message}`)
    return spokenAnswer("Sorry, I couldn't reach my memory just now.")
  }
}

/** For tests. */
export function resetMemoryCommands(): void {
  lastRemembered = null
  hooks = noHooks
}
