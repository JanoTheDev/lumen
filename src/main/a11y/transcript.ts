// Transcript confirmation and corrections (06 T14), wired to the query IPC and the bar:
//   - every user utterance is captioned ("I heard: …") before anything runs
//   - while a confirm waits, "yes" / "no" answer it; any other request replaces it
//   - "no, I said …", "correct that", "spell that" (pure parsing in ./captions)
//   - a11y.confirmTranscript: always = every action batch waits for an explicit yes,
//     risky = only batches that send, delete, close or pay, off = never
//   - a word corrected twice joins voiceVocab (Whisper's prompt)
import { loadConfig } from '../config'
import { log } from '../logger'
import { patchConfig } from '../ipc/settings'
import * as assistant from '../windows/assistant'
import { LOCAL_HANDLED } from './dispatch'
import {
  CaptionSession,
  VocabLearner,
  actionRisk,
  cardCoversBatch,
  confirmAnswer,
  describeActions,
  mergeVocab,
  needsTranscriptConfirm,
  type ActionRisk,
  type RiskAction
} from './captions'

const session = new CaptionSession()
const learner = new VocabLearner()
/** The user explicitly said yes to this utterance (always mode asks once per utterance). */
let confirmedTurn = false

export type UtteranceResult = { handled: unknown } | { prompt: string }

function learn(heard: string | null, corrected: string): void {
  if (!heard) return
  const words = learner.note(heard, corrected)
  if (!words.length) return
  const vocab = mergeVocab(loadConfig().voiceVocab, words)
  log('step', `vocabulary learned from corrections: ${words.join(', ')}`)
  void patchConfig({ voiceVocab: vocab })
}

function heardNow(text: string): void {
  session.heard(text)
  confirmedTurn = false
}

/** Every user utterance (not the pipeline's own follow-ups), before the router. */
export function beforeUtterance(prompt: string): UtteranceResult {
  if (assistant.confirmPending()) {
    const answer = confirmAnswer(prompt)
    if (answer) {
      assistant.command({ type: answer === 'yes' ? 'confirm' : 'deny' })
      return { handled: LOCAL_HANDLED }
    }
    // Something else: a new request, so the old action does not run.
    assistant.dropConfirm()
  }
  const step = session.handle(prompt)
  if (step?.type === 'draft') {
    assistant.setCaptionEdit(step.edit)
    return { handled: LOCAL_HANDLED }
  }
  if (step?.type === 'close') {
    assistant.setCaptionEdit(undefined)
    return { handled: LOCAL_HANDLED }
  }
  let text = prompt
  if (step?.type === 'rerun') {
    learn(session.lastHeard(), step.text)
    assistant.setCaptionEdit(undefined)
    text = step.text
  }
  heardNow(text)
  assistant.setCaption(text)
  return { prompt: text }
}

/** The bar's Edit button (true) or Escape in the editor (false). */
export function openEditor(open: boolean): void {
  if (open) assistant.setCaptionEdit(session.startEdit('edit'))
  else {
    session.cancelEdit()
    assistant.setCaptionEdit(undefined)
  }
}

/** The edited caption was submitted: it replaces the last utterance and runs. */
export function submitEdit(text: string): void {
  const heard = session.lastHeard()
  const run = session.submit(text)
  assistant.setCaptionEdit(undefined)
  if (!run) return
  learn(heard, run)
  assistant.send('assistant:run-query', run)
}

function heardLine(): string {
  const heard = session.lastHeard()
  return heard ? `I heard “${heard.length > 80 ? `${heard.slice(0, 79)}…` : heard}”. ` : ''
}

/**
 * Explain-before-do (assistant:announce). In "always" mode it has no countdown and says
 * what was heard, and a yes there covers the batch that follows.
 */
export async function explainBeforeDo(
  summary: string,
  risk: ActionRisk,
  countdownMs: number | undefined
): Promise<boolean> {
  const always = loadConfig().a11y.confirmTranscript === 'always'
  const ok = await assistant.requestConfirm(
    {
      summary: always ? `${heardLine()}${summary}` : summary,
      risk,
      countdownMs: always ? undefined : countdownMs
    },
    { gatesExecute: true }
  )
  if (ok && always) confirmedTurn = true
  return ok
}

/** Before an action batch runs: waits for yes when the policy asks; false = do not run. */
export async function confirmActions(actions: readonly RiskAction[]): Promise<boolean> {
  return (await confirmBatch(actions)).ok
}

/**
 * confirmActions plus whether the yes pre-approves the batch for the safety gate. Only a
 * card that showed these very actions counts (not a yes to the model's summary earlier in
 * the turn), and only when it listed all of them (cardCoversBatch); otherwise the gate still
 * asks for each high-risk action with its own reason.
 */
export async function confirmBatch(
  actions: readonly RiskAction[]
): Promise<{ ok: boolean; approved: boolean }> {
  if (!actions.length) return { ok: true, approved: false }
  const policy = loadConfig().a11y.confirmTranscript
  const risk = actionRisk(actions)
  if (!needsTranscriptConfirm(policy, risk)) return { ok: true, approved: false }
  if (policy === 'always' && confirmedTurn) return { ok: true, approved: false }
  const what = describeActions(actions)
  const ok = await assistant.requestConfirm({
    summary: `${heardLine()}I’ll ${what.charAt(0).toLowerCase()}${what.slice(1)}`,
    risk
  })
  if (ok) confirmedTurn = true
  else log('skip', `actions not confirmed (${policy}, ${risk})`)
  return { ok, approved: ok && cardCoversBatch(actions) }
}
