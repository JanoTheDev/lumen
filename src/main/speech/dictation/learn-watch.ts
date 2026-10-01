// Watches the field dictation was typed into (learn.ts decides what counts). One watch at a
// time: a newer dictation replaces it. Reads go through the agent's `uia_text {scope:
// 'focused'}` (TextPattern, else the value; never a password field) and `focus_info`.
import type { AgentBridge } from '../../agent/bridge'
import { log } from '../../logger'
import { findCorrections, noteCorrections, withLearned, type Correction } from './learn'

export const FIRST_READ_MS = 400
export const SECOND_READ_MS = 20_000
const READ_TIMEOUT_MS = 3000
const MAX_CHARS = 20_000

interface FieldText {
  text: string
  role: string
  name: string
  process: string
}

export interface LearnDeps {
  dictionary: () => readonly string[]
  /** Saves the new dictionary (and spell-as rules for respellings) and tells the user. */
  learned: (dictionary: string[], added: string[], found?: readonly Correction[]) => void
  storePath?: string
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

async function readField(agent: AgentBridge): Promise<FieldText | null> {
  const [focus, text] = await Promise.all([
    agent.request<Record<string, unknown>>('focus_info', {}, { timeoutMs: READ_TIMEOUT_MS }),
    agent.request<Record<string, unknown>>(
      'uia_text',
      { scope: 'focused', maxChars: MAX_CHARS },
      { timeoutMs: READ_TIMEOUT_MS }
    )
  ])
  const source = String(text?.source ?? '')
  if (source !== 'text' && source !== 'value') return null
  return {
    text: String(text?.text ?? ''),
    role: String(text?.role ?? ''),
    name: String(text?.name ?? ''),
    process: String(focus?.process ?? '').toLowerCase()
  }
}

function sameField(a: FieldText, b: FieldText): boolean {
  return a.process === b.process && a.role === b.role && a.name === b.name
}

let current: { timer: unknown; clear: (h: unknown) => void } | null = null

export function stopLearning(): void {
  if (current) current.clear(current.timer)
  current = null
}

/** Starts watching after `dictated` was typed. Needs an agent with `uia_text`. */
export function watchCorrections(agent: AgentBridge, dictated: string, deps: LearnDeps): void {
  stopLearning()
  if (!agent.hasCapability('uia-text')) return
  const set = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const mine = { timer: null as unknown, clear }
  current = mine
  const live = (): boolean => current === mine

  mine.timer = set(async () => {
    const before = await readField(agent).catch(() => null)
    if (!before || !live()) return
    mine.timer = set(async () => {
      if (!live()) return
      current = null
      const after = await readField(agent).catch(() => null)
      if (!after || !sameField(before, after) || after.text === before.text) return
      const found = findCorrections(dictated, before.text, after.text)
      if (!found.length) return
      log('step', `dictation corrections: ${found.map((c) => `${c.from}→${c.to}`).join(', ')}`)
      const dictionary = deps.dictionary()
      const added = noteCorrections(found, dictionary, deps.storePath)
      if (added.length) deps.learned(withLearned(dictionary, added), added, found)
    }, SECOND_READ_MS)
  }, FIRST_READ_MS)
}
