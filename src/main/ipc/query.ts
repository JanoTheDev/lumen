import { ipcMain } from 'electron'
import {
  actionsSchema,
  confidenceSchema,
  promptSchema,
  queryOptsSchema,
  textSchema
} from '@shared/ipc'
import type { Action, ModelResponse } from '@shared/types'
import { INVALID, safeParse } from './validate'
import { beginScope, cancelAll, endScope, isAbortError, type CancelScope } from '../query/cancel'
import { TaskQueue } from '../query/task-queue'
import type { CallOptions } from '../ai'
import { loadConfig } from '../config'
import { log, startTimer } from '../logger'
import { normalizeBbox } from '../actions/coords'
import { executeActions } from '../actions/executor'
import { armEscape, disarmEscape } from '../agent/escape'
import { setStatus } from '../windows/status'
import * as assistant from '../windows/assistant'
import { uiV2 } from '../windows/ui-mode'
import { confirmCountdownMs } from '../a11y/timings'
import { beforeUtterance, confirmActions, explainBeforeDo } from '../a11y/transcript'

const CANCELLED = { mode: 'answer', text: 'Cancelled.', cancelled: true } as const

export interface QueryIpcDeps {
  /** Router stages 1 + 2 (local grammar, prefilter); returns a response when handled. */
  intercept: (prompt: string) => unknown | undefined
  runQuery: (prompt: string, opts: CallOptions, scope: CancelScope) => Promise<ModelResponse>
  /** Runs first inside the queue; true = the utterance was fully handled (e.g. dictated). */
  preempt?: (prompt: string, opts: CallOptions, scope: CancelScope) => Promise<boolean>
}

/** Reply for an utterance that was typed as dictation instead of going to the assistant. */
export const DICTATED = { mode: 'answer', text: '', dictated: true } as const

export function registerQueryIpc(deps: QueryIpcDeps): void {
  const userQueue = new TaskQueue(1, 'request-queue')

  ipcMain.on('assistant:cancel', () => {
    if (cancelAll()) log('skip', 'cancel-current received — aborting in-flight work')
  })

  ipcMain.handle('assistant:query', async (_event, rawPrompt: unknown, rawOpts: unknown) => {
    const heard = safeParse('assistant:query', promptSchema, rawPrompt)
    const opts: CallOptions = safeParse('assistant:query', queryOptsSchema, rawOpts) ?? {}
    if (heard === undefined) return INVALID
    // The user's own words (follow-ups are lowDetail): caption, confirm answers, corrections.
    let prompt = heard
    if (!opts.lowDetail) {
      const u = beforeUtterance(heard)
      if ('handled' in u) return u.handled
      prompt = u.prompt
    }

    const intercepted = deps.intercept(prompt)
    if (intercepted !== undefined) return intercepted

    setStatus('thinking', 'Thinking', { index: 2, total: 3 })
    const scope = beginScope()
    armEscape()
    try {
      // Serialize user requests; parallel splits happen inside the turn (router).
      const result = await userQueue.enqueue(`"${prompt.slice(0, 40)}"`, async () =>
        (await deps.preempt?.(prompt, opts, scope)) ? DICTATED : deps.runQuery(prompt, opts, scope)
      )
      // Dictated, or handled with its own output (a lesson started): no status here.
      if ((result as { dictated?: boolean }).dictated) return result
      const modeLabel = (result as { mode?: string }).mode
      if (modeLabel === 'action') setStatus('acting', 'Executing', { index: 3, total: 3 }, 2000)
      else if (modeLabel === 'guide') setStatus('step', 'Guide ready', undefined, 2500)
      else setStatus('answer', 'Done', { index: 3, total: 3 }, 1400)
      return result
    } catch (e) {
      if (isAbortError(e) || scope.cancelled) {
        log('skip', 'query cancelled')
        setStatus('error', 'Cancelled', undefined, 1200)
        return CANCELLED
      }
      setStatus('error', `Error: ${(e as Error).message}`, undefined, 3000)
      throw e
    } finally {
      endScope(scope)
      disarmEscape()
    }
  })

  ipcMain.handle(
    'assistant:announce',
    async (_event, rawSummary: unknown, rawConfidence: unknown) => {
      const summary = safeParse('assistant:announce', textSchema, rawSummary)
      const confidence = safeParse('assistant:announce', confidenceSchema, rawConfidence)
      if (summary === undefined) return { delayMs: 0 }
      const cfg = loadConfig()
      if (!cfg.explainBeforeDo && !cfg.showConfidence) return { delayMs: 0 }
      if (!summary || !summary.trim()) return { delayMs: 0 }
      const conf = (confidence ?? 'high') as 'high' | 'medium' | 'low'
      if (uiV2() && cfg.explainBeforeDo) {
        // The bar asks with a countdown; Stop skips the execute that follows.
        await explainBeforeDo(
          summary.trim(),
          conf === 'low' ? 'medium' : 'low',
          confirmCountdownMs(cfg, conf === 'low' ? 4000 : conf === 'medium' ? 3000 : 2000)
        )
        return { delayMs: 0 }
      }
      const baseText = `About to: ${summary.trim()}`
      const displayText =
        cfg.showConfidence && conf !== 'high'
          ? `${conf === 'low' ? '⚠ Low confidence' : '◎ Medium confidence'} — ${baseText}. Say "cancel" to stop.`
          : baseText
      const kind = conf === 'low' ? 'error' : 'acting'
      const delayMs = conf === 'low' ? 2000 : conf === 'medium' ? 1500 : 1200
      setStatus(kind, displayText, undefined, delayMs + 1200)
      return { delayMs: cfg.explainBeforeDo ? delayMs : 0 }
    }
  )

  ipcMain.handle('assistant:execute', async (_event, rawActions: unknown) => {
    const parsed = safeParse('assistant:execute', actionsSchema, rawActions)
    if (!parsed) return INVALID
    const actions = parsed.map((a) => ({
      ...a,
      bbox: a.bbox ? (normalizeBbox(a.bbox) ?? undefined) : undefined
    })) as Action[]
    if (uiV2() && assistant.consumeDenied()) {
      log('skip', 'execute skipped: the user stopped it')
      return { done: false, cancelled: true }
    }
    // a11y.confirmTranscript: always / risky batches wait for an explicit yes.
    if (!(await confirmActions(actions))) return { done: false, cancelled: true }
    const scope = beginScope()
    armEscape()
    const execTimer = startTimer(`execute-action [${actions.map((a) => a.type).join(', ')}]`)
    try {
      const r = await executeActions(actions, { signal: scope.signal })
      log('done', r.cancelled ? 'execute cancelled' : 'execute complete')
      return { done: !r.cancelled, cancelled: r.cancelled, reached_bottom: r.reachedBottom }
    } finally {
      endScope(scope)
      disarmEscape()
      execTimer.total()
    }
  })
}
