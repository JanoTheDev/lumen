// Dictation: speak, get clean text typed into the focused field. Driven by the dedicated
// dictation hotkey (always pure dictation, never the assistant) and by auto-detect on the
// assistant hotkey. Text is saved for recovery until it has been typed.
import { clipboard } from 'electron'
import type { AgentBridge } from '../../agent/bridge'
import { armEscape, disarmEscape, holdEscape, keepEscapeWhile } from '../../agent/escape'
import { getAgent } from '../../agent/instance'
import { bus } from '../../bus'
import { loadConfig, type AppConfig } from '../../config'
import { log } from '../../logger'
import { patchConfig } from '../../ipc/settings'
import { beginScope, CancelledError, endScope, isAbortError } from '../../query/cancel'
import { setStatus, showAnswer } from '../../windows/assistant'
import { DictationActivation } from './activation'
import {
  autoDictateGate,
  classifyUtterance,
  isConfidentDictation,
  looksLikeRequest
} from './autodetect'
import { applyBacktrack } from './backtrack'
import { cleanupDictation } from './cleanup'
import { applyCodingMode } from './coding'
import { looksLikeEditCommand } from './command'
import { dropEditChip, runEditCommand } from './command-run'
import { appTermsFor, applySpellAs, rulesFromCorrections, withRules } from './dictionary'
import { addNote, handleNoteCommand } from './notes'
import { insertDictation, readFocus } from './insert'
import { watchCorrections, type LearnDeps } from './learn-watch'
import {
  archivePending,
  clearPending,
  recoveryMessage,
  savePending,
  takeRecoverable
} from './recovery'
import { noTextField, RecordingClock, scratchpadOnFailure } from './scratchpad'
import { takeScreenNames } from './screen-names'
import { shapeDictation, type ShapeExtras } from './shape'
import { expandSnippet, loadSnippets, matchSnippet } from './snippets'
import type { FocusTarget } from './terminal-guard'
import {
  claudeResolver,
  claudeTargetReady,
  matchClaudeDictation,
  sendToClaude,
  titleResolver
} from './to-claude'

type DictationConfig = AppConfig['dictation']

export interface DictateResult {
  ok: boolean
  notice?: string
}

export const NOTHING_HEARD = "Didn't hear anything to type"

/** What one dictation produced, typed or not (for 04 T44-T46 history and stats). */
export interface DictationReport {
  /** Transcript before any cleanup. */
  raw: string
  /** Text that was typed (or would have been); the new text for a command edit. */
  text: string
  /** Process of the target window. */
  app?: string
  source: 'hotkey' | 'auto' | 'command' | 'snippet'
  ok: boolean
  /** Dictation style applied (T36). */
  style?: string
  /** Length of the recording, when known (for words per minute). */
  durationMs?: number
}

export type DictationRecorder = (report: DictationReport) => void

let recorder: DictationRecorder | null = null

/** The one call site for history and stats: called once after every dictation. */
export function setDictationRecorder(fn: DictationRecorder | null): void {
  recorder = fn
}

function report(r: DictationReport): void {
  try {
    recorder?.(r)
  } catch (e) {
    log('fail', `dictation recorder failed: ${(e as Error).message}`)
  }
}

/** A saved snippet the whole utterance names, expanded; null when none (04 T38). */
function snippetFor(text: string, needLead: boolean): string | null {
  const m = matchSnippet(text, loadSnippets())
  if (!m || (needLead && !m.lead && m.score < 1)) return null
  log('plan', 'dictation snippet expanded')
  return expandSnippet(m.snippet.text, { clipboard: () => clipboard.readText() })
}

function tapHint(cfg: DictationConfig): string {
  return `Hold ${cfg.hotkey} to dictate, or double-tap it for hands-free`
}

const activation = new DictationActivation({
  start() {
    holdEscape('hud')
    bus.emit({ type: 'dictation.started' })
    setStatus('listening', 'Dictating…')
  },
  handsFree() {
    bus.emit({ type: 'dictation.hands-free' })
    setStatus('listening', 'Dictating hands-free. Pause or tap to finish')
  },
  stop() {
    bus.emit({ type: 'voice.stopped' })
    setStatus('transcribing', 'Transcribing')
  },
  cancel() {
    bus.emit({ type: 'voice.cancelled' })
    setStatus('answer', tapHint(loadConfig().dictation), undefined, 3500)
  }
})

// Hands-free dictation can run 3 minutes; Escape must still stop it.
keepEscapeWhile(() => activation.active)

bus.on('voice.cancelled', () => activation.reset())
// The renderer ended the recording (mic or transcription error, silence): a hands-free or
// held dictation is over too, so the next press starts a new one instead of "stopping" (M6).
bus.on('voice.stopped', (e) => {
  if (e.ended) activation.reset()
})

// Recording length for the speaking pace (T46): any recording's start and end.
const clock = new RecordingClock()
bus.on('dictation.started', () => clock.start())
bus.on('voice.started', () => clock.start())
bus.on('voice.stopped', () => clock.stop())
bus.on('voice.cancelled', () => clock.reset())

export function onDictationDown(): void {
  if (!loadConfig().dictation.enabled) return
  activation.down()
}

export function onDictationUp(): void {
  activation.up()
}

const learnDeps: LearnDeps = {
  dictionary: () => loadConfig().dictation.dictionary,
  learned(dictionary, added, found) {
    const cur = loadConfig().dictation
    // A respelling ("Figmah" fixed to "Figma") also becomes a spell-as rule (T39).
    const rules = rulesFromCorrections(found ?? [], added)
    const spellAs = rules.length ? withRules(cur.spellAs ?? [], rules) : cur.spellAs
    void patchConfig({ dictation: { ...cur, dictionary, spellAs } })
    const names = added.map((w) => `“${w}”`).join(', ')
    log('step', `dictionary learned: ${added.join(', ')}`)
    setStatus('answer', `Added ${names} to your dictionary (Settings, Voice)`, undefined, 5000)
  }
}

interface InsertMeta {
  raw: string
  source: DictationReport['source']
  style?: string
  softBreaks?: boolean
  durationMs?: number
}

export const SCRATCHPAD_NOTICE = 'No text field here, so it went to Notes in Home'

/** No text field to type into (T45): the dictation is kept as a note instead of lost. */
function toScratchpad(
  pendingId: string,
  text: string,
  target: FocusTarget,
  meta: InsertMeta
): DictateResult | null {
  try {
    addNote({ text, via: 'scratchpad', source: target.process ? { app: target.process } : {} })
  } catch (e) {
    log('fail', `dictation scratchpad note failed: ${(e as Error).message}`)
    return null
  }
  clearPending(pendingId)
  report({ ...reportBase(text, target, meta), ok: false })
  log('done', `dictation saved as a note (${text.length} chars)`)
  setStatus('answer', SCRATCHPAD_NOTICE, undefined, 4000)
  return { ok: true, notice: SCRATCHPAD_NOTICE }
}

function reportBase(
  text: string,
  target: FocusTarget,
  meta: InsertMeta
): Omit<DictationReport, 'ok'> {
  return {
    raw: meta.raw,
    text,
    app: target.process,
    source: meta.source,
    style: meta.style,
    durationMs: meta.durationMs
  }
}

const FILE_TAG_RE = /\b(?:at|tag) file\b/i

/** App terms, screen names and the file resolver for shaping (T39, T41, T42). */
async function shapeExtras(
  cleanedText: string,
  target: FocusTarget,
  cfg: DictationConfig
): Promise<ShapeExtras> {
  const [screenNames, resolveFile] = await Promise.all([
    takeScreenNames(),
    cfg.codingMode && FILE_TAG_RE.test(cleanedText) ? titleResolver(target.title) : undefined
  ])
  return { appTerms: appTermsFor(cfg.appDictionary, target), screenNames, resolveFile }
}

/** "To Claude, …" on the dictation hotkey (T42): cleaned, coding mode, sent to the session. */
async function dictateToClaude(
  body: string,
  raw: string,
  pendingId: string,
  cfg: DictationConfig,
  signal: AbortSignal,
  durationMs: number | undefined
): Promise<DictateResult> {
  const corrected = cfg.backtrack ? applyBacktrack(body).text : body
  const spoken = applySpellAs(corrected || body, cfg.spellAs)
  const [cleaned, resolveFile] = await Promise.all([
    cleanupDictation(spoken, {
      mode: cfg.cleanup,
      dictionary: cfg.dictionary,
      backtrack: cfg.backtrack,
      signal
    }),
    claudeResolver(),
    takeScreenNames()
  ])
  if (signal.aborted) throw new CancelledError()
  const text = applyCodingMode(cleaned.text, { resolveFile })
  const res = await sendToClaude(text)
  report({ raw, text, app: 'claude-code', source: 'hotkey', ok: res.ok, durationMs })
  if (res.ok) {
    clearPending(pendingId)
    log('done', `dictation sent to Claude (${text.length} chars)`)
    setStatus('answer', res.notice, undefined, 3000)
  } else {
    archivePending(pendingId)
    setStatus('error', res.notice, undefined, 4000)
    showAnswer(`${res.notice}\n\n${text}`)
  }
  return { ok: res.ok, notice: res.notice }
}

/** Types already-cleaned text; on failure the text is kept in recovered.txt and shown. */
async function finishInsert(
  agent: AgentBridge,
  pendingId: string,
  text: string,
  target: FocusTarget,
  cfg: DictationConfig,
  meta: InsertMeta
): Promise<DictateResult> {
  if (noTextField(target)) {
    const kept = toScratchpad(pendingId, text, target, meta)
    if (kept) return kept
  }
  const res = await insertDictation(agent, text, target, cfg.terminal, {
    softBreaks: meta.softBreaks
  })
  if (!res.ok && res.refused === 'password') {
    // A spoken password is never kept: not in history, recovery or on the bar (M7).
    clearPending(pendingId)
    log('skip', 'dictation not typed: password field')
    setStatus('error', res.notice, undefined, 4000)
    return { ok: false, notice: res.notice }
  }
  if (!res.ok && scratchpadOnFailure(target)) {
    const kept = toScratchpad(pendingId, text, target, meta)
    if (kept) return kept
  }
  // Refused for safety (a blocked terminal): shown and kept for recovery, not in history.
  if (res.ok || !res.refused) report({ ...reportBase(text, target, meta), ok: res.ok })
  if (res.ok) {
    clearPending(pendingId)
    log('done', `dictation typed (${text.length} chars${res.terminal ? ', terminal' : ''})`)
    if (!res.terminal) watchCorrections(agent, text, learnDeps)
    if (res.notice) setStatus('answer', res.notice, undefined, 5000)
    else setStatus('answer', 'Typed', undefined, 1200)
    return { ok: true, notice: res.notice }
  }
  archivePending(pendingId)
  log('fail', `dictation not typed: ${res.notice}`)
  setStatus('error', res.notice, undefined, 4000)
  showAnswer(`${res.notice}\n\n${text}`)
  return { ok: false, notice: res.notice }
}

/** The dictation hotkey's transcript: clean it up and type it. "" = nothing was heard. */
export async function dictate(raw: string): Promise<DictateResult> {
  activation.reset()
  const durationMs = clock.take()
  const text = raw.trim()
  if (!text) {
    setStatus('answer', NOTHING_HEARD, undefined, 1500)
    return { ok: false, notice: NOTHING_HEARD }
  }
  const cfg = loadConfig().dictation
  const pendingId = savePending(text)
  const agent = getAgent()
  if (!agent) {
    archivePending(pendingId)
    showAnswer(`The helper process is not running, so nothing was typed.

${text}`)
    return { ok: false, notice: 'agent not running' }
  }
  setStatus('thinking', cfg.cleanup === 'light' ? 'Cleaning up' : 'Typing')
  dropEditChip()
  // Escape (and the voice cancel) cancels the cleanup call and skips typing.
  const scope = beginScope()
  armEscape()
  try {
    const focus = readFocus(agent)
    // Command mode (T37): "make this shorter" with text selected edits the selection.
    if (cfg.commandMode && looksLikeEditCommand(text)) {
      const target = await focus
      const edited = await runEditCommand(agent, text, target, scope.signal)
      if (edited) {
        clearPending(pendingId)
        const out = edited.text ?? ''
        report({
          raw: text,
          text: out,
          app: target.process,
          source: 'command',
          ok: edited.ok,
          durationMs
        })
        return { ok: edited.ok, notice: edited.notice }
      }
    }
    // "To Claude, …" goes to the Claude Code session (T42), only from a terminal, an editor
    // or Lumen with a session focused; anywhere else the words are typed (M3).
    const toClaude = cfg.codingMode ? matchClaudeDictation(text) : null
    if (toClaude && (await claudeTargetReady(await focus)))
      return await dictateToClaude(toClaude, text, pendingId, cfg, scope.signal, durationMs)
    const snippet = cfg.snippets ? snippetFor(text, false) : null
    if (snippet)
      return await finishInsert(agent, pendingId, snippet, await focus, cfg, {
        raw: text,
        source: 'snippet',
        durationMs
      })
    // Course correction (T34) before cleanup; the cleanup check runs on the corrected text.
    const corrected = cfg.backtrack ? applyBacktrack(text).text : text
    if (!corrected.trim()) {
      clearPending(pendingId)
      setStatus('answer', 'Scratched that', undefined, 1500)
      return { ok: true, notice: 'nothing left after the correction' }
    }
    const [cleaned, target] = await Promise.all([
      // Spell-as rules (T39) before cleanup, so the model sees the written form.
      cleanupDictation(applySpellAs(corrected, cfg.spellAs), {
        mode: cfg.cleanup,
        dictionary: cfg.dictionary,
        backtrack: cfg.backtrack,
        signal: scope.signal
      }),
      focus
    ])
    scope.throwIfCancelled()
    log('plan', `dictation cleanup: ${cleaned.source}`)
    const extras = await shapeExtras(cleaned.text, target, cfg)
    scope.throwIfCancelled()
    const shaped = shapeDictation(cleaned, target, cfg, extras)
    return await finishInsert(agent, pendingId, shaped.text, target, cfg, {
      raw: text,
      source: 'hotkey',
      durationMs,
      style: shaped.style,
      softBreaks: shaped.softBreaks
    })
  } catch (e) {
    if (!scope.cancelled && !isAbortError(e)) throw e
    clearPending(pendingId)
    log('skip', 'dictation cancelled')
    setStatus('error', 'Cancelled', undefined, 1200)
    return { ok: false, notice: 'cancelled' }
  } finally {
    endScope(scope)
    disarmEscape()
  }
}

/**
 * Auto-detect for the assistant hotkey. Returns true when the utterance was typed as
 * dictation; false sends it on to the assistant as usual.
 */
export async function maybeAutoDictate(prompt: string, signal?: AbortSignal): Promise<boolean> {
  const durationMs = clock.take()
  // "take a note …" (04 T45) is saved to Home Notes, whatever is focused.
  if (await handleNoteCommand(prompt)) return true
  const cfg = loadConfig().dictation
  if (!cfg.enabled || !cfg.autoDetect || looksLikeRequest(prompt)) return false
  const agent = getAgent()
  if (!agent) return false
  const target = await readFocus(agent)
  if (!autoDictateGate(prompt, cfg, target)) return false
  // "insert my signature" with a text field focused (T38).
  const snippet = cfg.snippets ? snippetFor(prompt, true) : null
  if (snippet) {
    const id = savePending(prompt)
    await finishInsert(agent, id, snippet, target, cfg, {
      raw: prompt,
      source: 'snippet',
      durationMs
    })
    return true
  }

  const spoken = cfg.backtrack ? applyBacktrack(prompt).text : prompt
  const cleanup = cleanupDictation(applySpellAs(spoken || prompt, cfg.spellAs), {
    mode: cfg.cleanup,
    dictionary: cfg.dictionary,
    backtrack: cfg.backtrack,
    signal
  })
  cleanup.catch(() => {})
  const verdict = await classifyUtterance(prompt, target, { signal })
  log(
    'plan',
    `auto-dictate check: ${verdict ? `${verdict.kind} ${verdict.confidence.toFixed(2)}` : 'failed'}`
  )
  if (!isConfidentDictation(verdict)) return false

  const pendingId = savePending(prompt)
  let cleaned
  try {
    cleaned = await cleanup
    if (signal?.aborted) throw new CancelledError()
  } catch (e) {
    // Cancelled: the user dropped this text, so it is not offered back at the next start.
    clearPending(pendingId)
    throw e
  }
  const shaped = shapeDictation(cleaned, target, cfg, await shapeExtras(cleaned.text, target, cfg))
  await finishInsert(agent, pendingId, shaped.text, target, cfg, {
    raw: prompt,
    source: 'auto',
    durationMs,
    style: shaped.style,
    softBreaks: shaped.softBreaks
  })
  return true
}

/**
 * Offers dictation left over from the last run (crash or failed insert). The pending file is
 * read now, before any new dictation can add to it; only the card waits `showAfterMs`.
 */
export function offerRecovery(showAfterMs = 0): void {
  let items
  try {
    items = takeRecoverable()
  } catch (e) {
    log('fail', `dictation recovery failed: ${(e as Error).message}`)
    return
  }
  if (!items.length) return
  log('plan', `recovered ${items.length} dictation(s)`)
  const message = recoveryMessage(items)
  setTimeout(() => showAnswer(message), showAfterMs)
}
