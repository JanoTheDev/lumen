// One user turn: gather screen context, steer the prompt, call the model (directly, via the
// planner or the research loop) and present the result.
import type { ModelResponse } from '@shared/types'
import type { CancelScope } from './cancel'
import { needsScreenshot, takeSpeculative, type QueryContext } from './context'
import { applyOverrides, LOCATE_RE } from './overrides'
import { isResearchIntent } from './query-classifier'
import { correctNthElement } from './nth'
import { runPlanned, runResearch } from './research'
import { present, type GuideStartFn } from './present'
import { callModel, type CallOptions } from '../ai'
import { addToHistory } from '../ai/history'
import { isHowToQuestion } from '../guides/voice-nav'
import { requireAgent } from '../agent/instance'
import { loadConfig } from '../config'
import { log, startTimer } from '../logger'
import * as highlight from '../windows/highlight'
import { sleep } from '../util'

export interface PipelineDeps {
  speak: (text: string, voice: string) => Promise<void>
  onGuide: GuideStartFn
}

// Effective prompt of the previous full turn, for "do it" continuations.
let lastTaskContext: string | null = null

// Active window + optional screenshot. Lumen's own highlight layer is hidden first so it
// is not in the image; the foreground app is never changed.
export async function captureContext(withScreenshot: boolean): Promise<QueryContext> {
  const agent = requireAgent()
  if (!withScreenshot) return { activeWindow: await agent.activeWindow(), screenshot: null }
  if (highlight.isVisible()) {
    highlight.hide()
    await sleep(32)
  }
  const [activeWindow, screenshot] = await Promise.all([agent.activeWindow(), agent.screenshot()])
  return { activeWindow, screenshot }
}

export async function runQuery(
  prompt: string,
  baseOpts: CallOptions,
  scope: CancelScope,
  deps: PipelineDeps
): Promise<ModelResponse> {
  requireAgent()
  const opts: CallOptions = { ...baseOpts, signal: scope.signal }
  const timer = startTimer(`query "${prompt.slice(0, 60)}"${opts.lowDetail ? ' [low-detail]' : ''}`)
  log('plan', `prompt: "${prompt}"${opts.lowDetail ? ' [low-detail]' : ''}`)

  const needsShot = needsScreenshot(prompt)
  log('plan', `needs screenshot: ${needsShot}`)

  const speculative = needsShot ? takeSpeculative() : null
  let ctx = speculative ? await speculative.catch(() => null) : null
  if (ctx) log('plan', 'using speculative screenshot')
  else ctx = await captureContext(needsShot)
  const { activeWindow, screenshot } = ctx
  scope.throwIfCancelled()
  timer.split('context gathered (screenshot + active window)')
  log('plan', `active window: ${activeWindow}`)

  const { effectivePrompt, flags, intent, requestedApp, nextTaskContext } = applyOverrides({
    prompt,
    activeWindow,
    lowDetail: opts.lowDetail,
    lastTaskContext
  })
  if (flags.length) log('plan', `overrides: ${flags.join(', ')}`)
  if (requestedApp) log('plan', `app-switch detected: ${requestedApp.app} → ${requestedApp.url}`)
  if (intent.isContinuation && lastTaskContext)
    log('plan', `continuation detected, re-running: "${lastTaskContext}"`)
  lastTaskContext = nextTaskContext

  log('plan', `query: "${effectivePrompt.slice(0, 80)}"`)

  let result: ModelResponse

  const researchMode = !opts.lowDetail && isResearchIntent(prompt)

  if (researchMode) {
    result = await runResearch(prompt, activeWindow, opts, scope)
    timer.split('research agent done')
  } else if (!opts.lowDetail && intent.planRequired) {
    result = await runPlanned(effectivePrompt, activeWindow, opts, scope, timer)
  } else {
    result = correctNthElement(await callModel(effectivePrompt, screenshot, activeWindow, opts))
    timer.split('callModel done')
  }

  log('done', `mode: ${result.mode}`)
  timer.total()
  // Nothing from a cancelled turn may reach the screen, TTS or history.
  scope.throwIfCancelled()

  // Locate request → action+navigate+follow_up: AI generates action follow_up, but we need locate.
  // Replace the AI's follow_up with a proper locate query so highlights appear after navigation.
  if (
    !opts.lowDetail &&
    intent.mode === 'locate' &&
    LOCATE_RE.test(prompt) &&
    result.mode === 'action' &&
    result.follow_up
  ) {
    result.follow_up.query = `The page is loaded. Highlight where the user can find: "${prompt}". Respond ONLY with {"mode":"locate","items":[...]} — each item bbox tightly wraps only the matching visible rows/elements. Do NOT click, navigate, or open anything.`
    console.log('[locate-chain] replaced follow_up with locate query')
  }

  // Fallback: if AI still returns guide for an imperative request, auto-convert to click_bbox
  const IMPERATIVE_RE = /\b(open|click|go to|navigate|select|tap|press)\b/i
  if (
    result.mode === 'guide' &&
    IMPERATIVE_RE.test(prompt) &&
    !isHowToQuestion(prompt) &&
    result.steps?.some((s) => s.bbox)
  ) {
    const best = result.steps.find((s) => s.bbox)!
    console.log('[auto-action] guide→action fallback, clicking:', best.label)
    return {
      mode: 'action' as const,
      actions: [
        {
          type: 'click_bbox' as const,
          bbox: best.bbox!,
          description: best.target_hint,
          button: 'left' as const
        }
      ],
      summary: best.label
    }
  }

  // Start TTS synth early — parallel to renderer showing the answer card
  if (result.mode === 'answer' && result.text?.trim()) {
    const cfgNow = loadConfig()
    if (cfgNow.voice.tts === 'cloud') {
      deps
        .speak(result.text.trim(), cfgNow.voice.ttsVoice)
        .catch((e) => console.warn('[tts] early synth failed:', (e as Error).message))
    }
  }

  // Save exchange to history (text only — images not stored)
  if (!opts.lowDetail) {
    const summary =
      result.mode === 'answer'
        ? result.text
        : result.mode === 'action'
          ? (result.summary ?? `action: ${result.actions?.map((a) => a.type).join(', ')}`)
          : result.mode === 'guide'
            ? `guide: ${result.steps?.map((s) => s.label).join(', ')}`
            : result.mode === 'text_insert'
              ? `inserted text`
              : `located: ${result.items?.map((i) => i.label).join(', ')}`
    addToHistory(prompt, summary)
  }

  present(result, prompt, deps.onGuide)
  return result
}
