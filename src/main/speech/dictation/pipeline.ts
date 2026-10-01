// Dictation: speak, get clean text typed into the focused field. Driven by the dedicated
// dictation hotkey (always pure dictation, never the assistant) and by auto-detect on the
// assistant hotkey. Text is saved for recovery until it has been typed.
import type { AgentBridge } from '../../agent/bridge'
import { holdEscape } from '../../agent/escape'
import { getAgent } from '../../agent/instance'
import { bus } from '../../bus'
import { loadConfig, type AppConfig } from '../../config'
import { log } from '../../logger'
import * as answer from '../../windows/answer'
import { setStatus } from '../../windows/status'
import { DictationActivation } from './activation'
import {
  autoDictateGate,
  classifyUtterance,
  isConfidentDictation,
  looksLikeRequest
} from './autodetect'
import { cleanupDictation } from './cleanup'
import { insertDictation, readFocus } from './insert'
import {
  archivePending,
  clearPending,
  recoveryMessage,
  savePending,
  takeRecoverable
} from './recovery'
import type { FocusTarget } from './terminal-guard'

type DictationConfig = AppConfig['dictation']

export interface DictateResult {
  ok: boolean
  notice?: string
}

export const NOTHING_HEARD = "Didn't hear anything to type"

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

bus.on('voice.cancelled', () => activation.reset())

export function onDictationDown(): void {
  if (!loadConfig().dictation.enabled) return
  activation.down()
}

export function onDictationUp(): void {
  activation.up()
}

/** Types already-cleaned text; on failure the text is kept in recovered.txt and shown. */
async function finishInsert(
  agent: AgentBridge,
  pendingId: string,
  text: string,
  target: FocusTarget,
  cfg: DictationConfig
): Promise<DictateResult> {
  const res = await insertDictation(agent, text, target, cfg.terminal)
  if (res.ok) {
    clearPending(pendingId)
    log('done', `dictation typed (${text.length} chars${res.terminal ? ', terminal' : ''})`)
    if (res.notice) setStatus('answer', res.notice, undefined, 5000)
    else setStatus('answer', 'Typed', undefined, 1200)
    return { ok: true, notice: res.notice }
  }
  archivePending(pendingId)
  log('fail', `dictation not typed: ${res.notice}`)
  setStatus('error', res.notice, undefined, 4000)
  answer.showText(`${res.notice}\n\n${text}`)
  return { ok: false, notice: res.notice }
}

/** The dictation hotkey's transcript: clean it up and type it. "" = nothing was heard. */
export async function dictate(raw: string): Promise<DictateResult> {
  activation.reset()
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
    answer.showText(`The helper process is not running, so nothing was typed.\n\n${text}`)
    return { ok: false, notice: 'agent not running' }
  }
  setStatus('thinking', cfg.cleanup === 'light' ? 'Cleaning up' : 'Typing')
  const [cleaned, target] = await Promise.all([
    cleanupDictation(text, { mode: cfg.cleanup, dictionary: cfg.dictionary }),
    readFocus(agent)
  ])
  log('plan', `dictation cleanup: ${cleaned.source}`)
  return finishInsert(agent, pendingId, cleaned.text, target, cfg)
}

/**
 * Auto-detect for the assistant hotkey. Returns true when the utterance was typed as
 * dictation; false sends it on to the assistant as usual.
 */
export async function maybeAutoDictate(prompt: string, signal?: AbortSignal): Promise<boolean> {
  const cfg = loadConfig().dictation
  if (!cfg.enabled || !cfg.autoDetect || looksLikeRequest(prompt)) return false
  const agent = getAgent()
  if (!agent) return false
  const target = await readFocus(agent)
  if (!autoDictateGate(prompt, cfg, target)) return false

  const cleanup = cleanupDictation(prompt, {
    mode: cfg.cleanup,
    dictionary: cfg.dictionary,
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
  const cleaned = await cleanup
  await finishInsert(agent, pendingId, cleaned.text, target, cfg)
  return true
}

/** Offers dictation left over from the last run (crash or failed insert). */
export function offerRecovery(): void {
  let items
  try {
    items = takeRecoverable()
  } catch (e) {
    log('fail', `dictation recovery failed: ${(e as Error).message}`)
    return
  }
  if (!items.length) return
  log('plan', `recovered ${items.length} dictation(s)`)
  answer.showText(recoveryMessage(items))
}
