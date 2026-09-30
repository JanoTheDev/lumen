import { config } from 'dotenv'
import { join } from 'path'
// Keys are read at runtime, never baked into the bundle. Dev: repo .env. Installed: userData/.env.
config({ path: join(process.cwd(), '.env'), quiet: true })
try {
  config({ path: join(app.getPath('userData'), '.env'), quiet: true })
} catch {
  /* userData unavailable this early on some setups; repo .env still applies */
}

import { app, shell, BrowserWindow, globalShortcut } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import type { Action, Rect } from '@shared/types'
import { callClaude, needsScreenshot, warmupConnection, addToHistory, findClickCoordinates, isBrowser, type CallOptions, type ClaudeResponse } from './claude'
import { correctNthElement } from './nth-utils'
import { AgentBridge } from './agent/bridge'
import OpenAI, { toFile } from 'openai'
import { isResearchIntent } from './query-classifier'
import { buildPlan, executePlan, runResearchAgent } from './task-planner'
import { log, startTimer } from './logger'
import { loadConfig, lastConfigWarning, type AppConfig } from './config'
import { modelInstalled, installModel } from './wake-model'
import { saveGuide, loadSavedGuide, findGuideByName, type GuideStep, type SavedGuide } from './guides/store'
import { parseGuideNav, isReplayRequest, matchSaveGuide, matchPlayGuide, isHowToQuestion } from './guides/voice-nav'
import { beginScope, endScope, cancelAll, type CancelScope } from './query/cancel'
import { applyOverrides, LOCATE_RE } from './query/overrides'
import { startSpeculativeCapture, takeSpeculative, type QueryContext } from './query/context'
import { currentFrame, imageRectToPhys, imageToPhys, physRectToLogical, physToLogical, rectCenter, isUsableRect } from './actions/coords'
import { toAgentAction, type AgentAction } from './actions/agent-action'
import { isOwnRendererUrl } from './windows/factory'
import { assertSafeUrl, isSafeUrl, checkAction, needsWindowContext } from './actions/safety'
import { bus } from './bus'
import { applyUiScaleOnLoad, isOverOwnWindow } from './windows/registry'
import { setStatus, type StatusKind } from './windows/status'
import * as hud from './windows/hud'
import * as statusWin from './windows/status'
import * as answer from './windows/answer'
import * as highlight from './windows/highlight'
import * as dwellRing from './windows/dwell-ring'
import * as tray from './windows/tray'
import { sleep } from './util'
import { registerAnswerIpc } from './ipc/answer'
import { registerGuidesIpc } from './ipc/guides'
import { registerHighlightIpc } from './ipc/highlight'
import { registerHudIpc } from './ipc/hud'
import { registerQueryIpc } from './ipc/query'
import { registerSettingsIpc } from './ipc/settings'
import { registerVoiceIpc } from './ipc/voice'
import { registerWakeIpc } from './ipc/wake'

let agent: AgentBridge | null = null

function cancelPhraseList(cfg: AppConfig): string[] {
  if (!cfg.cancelVoice.enabled) return []
  return cfg.cancelVoice.phrases.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
}

function applyDwellState(cfg: AppConfig): void {
  if (!agent) return
  if (cfg.dwellClick.enabled) {
    agent.enableDwell(cfg.dwellClick.dwellMs, cfg.dwellClick.cooldownMs).catch(e =>
      console.error('[dwell] enable failed:', (e as Error).message))
  } else {
    agent.disableDwell().catch(() => {})
  }
  dwellRing.setEnabled(cfg.dwellClick.enabled)
}

function applyListenerState(cfg: AppConfig): void {
  if (!agent) return
  const wakeOn = cfg.wakeWord.enabled && cfg.wakeWord.phrase.trim().length > 0
  const cancelOn = cfg.cancelVoice.enabled
  if (!wakeOn && !cancelOn) {
    agent.disableListener().catch(() => {})
    return
  }
  if (!modelInstalled()) {
    installModel()
      .then(() => agent?.enableListener(wakeOn ? cfg.wakeWord.phrase : '', cancelPhraseList(cfg)))
      .catch(e => console.error('[listener] model install failed:', (e as Error).message))
    return
  }
  agent.enableListener(wakeOn ? cfg.wakeWord.phrase : '', cancelPhraseList(cfg))
    .catch(e => console.error('[listener] enable failed:', (e as Error).message))
}

async function applyAgentState(cfg: AppConfig): Promise<void> {
  if (!agent) return
  try {
    await agent.setHotkey(cfg.hotkey)
  } catch (e) {
    console.error('[hotkey] bind failed:', (e as Error).message)
  }
  applyListenerState(cfg)
  applyDwellState(cfg)
}

async function speakAnswer(text: string, voice: string): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[tts] OPENAI_API_KEY missing — skipping')
    return
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 })
  // Strip markdown to avoid reading "asterisk asterisk bold asterisk asterisk"
  const cleaned = text
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
  const result = await client.audio.speech.create({
    model: 'tts-1',
    voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
    input: cleaned,
    response_format: 'mp3',
  })
  const buf = Buffer.from(await result.arrayBuffer())
  const b64 = buf.toString('base64')
  answer.send('voice:tts-audio', { mime: 'audio/mpeg', data: b64 })
}

interface ActiveGuide {
  steps: GuideStep[]
  index: number
}
let activeGuide: ActiveGuide | null = null
let lastGuide: { task: string; steps: ActiveGuide['steps']; savedAt: number } | null = null

function saveLastAsGuide(name: string): SavedGuide | null {
  if (!lastGuide) return null
  const entry = saveGuide(lastGuide.task, lastGuide.steps, name)
  log('done', `saved guide "${entry.name}" as ${entry.id}`)
  return entry
}

// Re-run a saved guide by sending its task back through the normal query pipeline.
// Saved bboxes can drift as the UI changes — a fresh query re-computes them against
// whatever the user is looking at right now.
function replaySavedGuide(id: string): SavedGuide | null {
  const entry = loadSavedGuide(id)
  if (!entry) return null
  log('step', `replaying saved guide "${entry.name}" (fresh query)`)
  setStatus('thinking', `Replaying: ${entry.name}`, { index: 2, total: 3 })
  hud.send('assistant:run-query', entry.task)
  return entry
}

function handleGuideNavCommand(prompt: string): { handled: boolean; response?: unknown } {
  if (!activeGuide) return { handled: false }
  const text = prompt.trim()
  if (!text || text.length > 60) return { handled: false }

  const showStep = (idx: number): void => {
    if (!activeGuide) return
    const clamped = Math.max(0, Math.min(activeGuide.steps.length - 1, idx))
    activeGuide.index = clamped
    const step = activeGuide.steps[clamped]
    const total = activeGuide.steps.length
    setStatus('step', step.label, { index: clamped + 1, total })
    if (step.bbox) {
      highlight.send('screen:highlights', [step])
      highlight.show()
      const c = rectCenter(step.bbox)
      highlight.send('screen:pointer', {
        x: Math.round(c.x),
        y: Math.round(c.y),
        text: `${clamped + 1}/${total}: ${step.label}`,
      })
    }
  }

  const cmd = parseGuideNav(text)
  if (cmd === 'done') {
    activeGuide = null
    highlight.clear()
    setStatus('idle', 'Guide closed', undefined, 900)
    return { handled: true, response: { mode: 'answer', text: 'Guide closed.' } }
  }
  if (cmd === 'next') {
    if (activeGuide.index >= activeGuide.steps.length - 1) {
      setStatus('answer', 'Last step', undefined, 1400)
      return { handled: true, response: { mode: 'answer', text: 'You are on the last step.' } }
    }
    showStep(activeGuide.index + 1)
    return { handled: true, response: { mode: 'answer', text: `Step ${activeGuide.index + 1}: ${activeGuide.steps[activeGuide.index].label}` } }
  }
  if (cmd === 'prev') {
    showStep(Math.max(0, activeGuide.index - 1))
    return { handled: true, response: { mode: 'answer', text: `Step ${activeGuide.index + 1}: ${activeGuide.steps[activeGuide.index].label}` } }
  }
  if (cmd === 'repeat') {
    const step = activeGuide.steps[activeGuide.index]
    setStatus('step', step.label, { index: activeGuide.index + 1, total: activeGuide.steps.length })
    return { handled: true, response: { mode: 'answer', text: `Step ${activeGuide.index + 1}: ${step.label}` } }
  }
  return { handled: false }
}

// Guide voice commands handled before any model call; returns a response when handled.
function interceptGuideCommand(prompt: string): unknown | undefined {
  // Guide voice nav: "next step", "back", "repeat", "done"
  const nav = handleGuideNavCommand(prompt)
  if (nav.handled) return nav.response

  // Play-saved-guide voice: "play guide <name>" / "run guide <name>"
  const playName = matchPlayGuide(prompt)
  if (playName) {
    const found = findGuideByName(playName)
    if (found) {
      replaySavedGuide(found.id)
      return { mode: 'answer', text: `Playing "${found.name}" (${found.steps.length} steps). Say "next" to advance.` }
    }
    return { mode: 'answer', text: `No saved guide matches "${playName}".` }
  }

  // Save-guide voice command
  const saveMatch = matchSaveGuide(prompt)
  if (saveMatch && lastGuide) {
    const name = saveMatch.name ?? lastGuide.task
    const saved = saveLastAsGuide(name)
    if (saved) return { mode: 'answer', text: `Saved as "${saved.name}". Say "play guide ${name}" to replay.` }
  }

  // Guide replay: "replay last guide", "do the guide again"
  if (lastGuide && isReplayRequest(prompt)) {
    activeGuide = { steps: lastGuide.steps, index: 0 }
    setStatus('step', lastGuide.steps[0]?.label ?? 'Replaying guide', { index: 1, total: lastGuide.steps.length })
    highlight.send('screen:highlights', lastGuide.steps)
    highlight.show()
    return { mode: 'answer', text: `Replaying guide: "${lastGuide.task}" (${lastGuide.steps.length} steps). Say "next" to advance.` }
  }
  return undefined
}

async function transcribeAudio(audio: ArrayBuffer): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('Whisper requires OPENAI_API_KEY')

  // Skip Whisper on tiny recordings — model hallucinates on < ~0.5s of audio
  if (audio.byteLength < 6000) {
    console.log('[transcribe] audio too short (', audio.byteLength, 'bytes), skipping')
    return ''
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 })
  const userVocab = loadConfig().voiceVocab.trim()
  const vocabList = userVocab
    ? `, ${userVocab.split(/[,\n]/).map(s => s.trim()).filter(Boolean).join(', ')}`
    : ''
  const whisperPrompt = `AI assistant voice command. User speaks English. Common words: open, click, email, Gmail, drafts, inbox, reply, compose, send, navigate, GitHub, Lumen, Claude, Anthropic${vocabList}.`
  const result = await client.audio.transcriptions.create({
    // Sent from memory; recordings never touch disk.
    file: await toFile(Buffer.from(audio), 'recording.webm', { type: 'audio/webm' }),
    model: 'whisper-1',
    language: 'en',
    prompt: whisperPrompt,
  })
  console.log('[transcribe] result:', result.text)
  const estSecs = audio.byteLength / 6000
  const whisperCost = (estSecs / 60) * 0.006
  console.log(`[tokens] whisper | ~${estSecs.toFixed(1)}s audio | $${whisperCost.toFixed(5)}`)
  return result.text
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.aioverlay')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  // No Lumen window may open popups or navigate away from its own renderer.
  app.on('web-contents-created', (_, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeUrl(url)) shell.openExternal(assertSafeUrl(url)).catch(() => {})
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isOwnRendererUrl(url)) {
        event.preventDefault()
        log('fail', `blocked navigation to ${url}`)
      }
    })
  })

  hud.create()
  highlight.create()
  answer.create()
  statusWin.create()
  dwellRing.create()
  tray.create()
  // Apply saved UI scale once windows finish loading
  applyUiScaleOnLoad(loadConfig().a11y.uiScale)

  const configWarning = lastConfigWarning()
  if (configWarning) setStatus('error', configWarning, undefined, 8000)

  // Hotkey, listener and dwell state are re-sent after every agent (re)start.
  let agentFailed = false
  agent = new AgentBridge({ initState: () => applyAgentState(loadConfig()) })
  agent.onEvent('agent-down', (data) => {
    if (data?.gaveUp) setStatus('error', 'Agent stopped responding — see logs', undefined, 8000)
    else setStatus('error', 'Agent restarting…', undefined, 3000)
  })
  agent.onEvent('agent-ready', () => {
    if (agentFailed) setStatus('answer', 'Agent back online', undefined, 1500)
    agentFailed = false
  })
  // Not awaited: IPC handlers below must be registered before the windows finish loading.
  agent.start().catch((e) => {
    agentFailed = true
    log('fail', `agent failed to start: ${(e as Error).message}`)
    setStatus('error', 'Agent failed to start — see logs', undefined, 8000)
  })
  warmupConnection()
  loadConfig()  // warm cache

  agent.onEvent('hotkey-down', () => {
    const handsFree = loadConfig().handsFreeMode
    console.log(`[hotkey] down — handsFree=${handsFree}`)
    armEscape()
    // Tap-to-talk (hands-free) uses the same auto-stop-on-silence path as wake-word activation
    bus.emit({ type: 'voice.started', handsFree })
    setStatus('listening', handsFree ? 'Listening (hands-free)…' : 'Listening…')
  })

  agent.onEvent('dwell-progress', (data) => {
    if (!loadConfig().dwellClick.enabled) return
    dwellRing.progress(data)
  })

  agent.onEvent('dwell-trigger', (data) => {
    if (!loadConfig().dwellClick.enabled) return
    const x = data?.x as number | undefined
    const y = data?.y as number | undefined
    if (typeof x !== 'number' || typeof y !== 'number') return
    // Suppress dwell-click over the HUD / answer / status / settings windows
    if (isOverOwnWindow(physToLogical({ x, y }))) return
    console.log(`[dwell] click at (${x}, ${y})`)
    setStatus('acting', 'Dwell click', undefined, 900)
    agent!.execute({ type: 'click', x, y, button: 'left' }).catch(e =>
      console.error('[dwell] click failed:', (e as Error).message))
  })

  agent.onEvent('voice-cancel', (data) => {
    const phrase = (data?.phrase as string | undefined) ?? 'cancel'
    console.log(`[cancel-voice] matched "${phrase}"`)
    if (cancelAll()) {
      setStatus('error', 'Cancelled by voice', undefined, 1600)
    } else {
      // Not in a query — treat as "close any active UI"
      bus.emit({ type: 'voice.cancelled' })
      activeGuide = null
      highlight.clear()
    }
  })

  agent.onEvent('wake-detected', () => {
    console.log('[wake] detected — showing HUD, starting recording with VAD auto-stop')
    armEscape()
    bus.emit({ type: 'voice.started', handsFree: true })
    setStatus('listening', 'Wake word detected — listening…')
  })

  agent.onEvent('hotkey-up', () => {
    if (loadConfig().handsFreeMode) {
      // In hands-free mode the VAD loop stops recording automatically; ignore release.
      return
    }
    console.log('[hotkey] up — stopping recording, keeping HUD visible until query done')
    bus.emit({ type: 'voice.stopped' })
    setStatus('transcribing', 'Transcribing', { index: 1, total: 3 })
    // Capture while speech is transcribed; runQuery awaits this promise if it is fresh.
    startSpeculativeCapture(() => captureContext(true))
  })



  agent.onEvent('mouse-moved', () => {
    if (!loadConfig().guideAutoDismissOnMove) return
    highlight.clear()
    activeGuide = null
  })



  let lastTaskContext: string | null = null


  async function runQuery(prompt: string, baseOpts: CallOptions, scope: CancelScope): Promise<ClaudeResponse> {
    if (!agent) throw new Error('Agent not ready')
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

    const { effectivePrompt, intent, requestedApp, nextTaskContext } = applyOverrides({
      prompt,
      activeWindow,
      lowDetail: opts.lowDetail,
      lastTaskContext,
    })
    if (requestedApp) log('plan', `app-switch detected: ${requestedApp.app} → ${requestedApp.url}`)
    if (intent.isContinuation && lastTaskContext) log('plan', `continuation detected, re-running: "${lastTaskContext}"`)
    lastTaskContext = nextTaskContext

    log('plan', `query: "${effectivePrompt.slice(0, 80)}"`)

    let result: ClaudeResponse

    const researchMode = !opts.lowDetail && isResearchIntent(prompt)

    if (researchMode) {
      // Autonomous loop: keep navigating/clicking/scrolling until the info is found or stuck.
      result = await runResearchAgent(
        prompt,
        activeWindow,
        (p, s, w) => callClaude(p, s, w, opts),
        () => agent!.screenshot(),
        async (actions) => {
          const frame = currentFrame()
          let prev: AgentAction | undefined
          for (const action of actions as Action[]) {
            if (scope.cancelled) break
            const scaled = toAgentAction(action, frame)
            if (!(await passesPolicy(scaled, prev))) break
            prev = scaled
            if (scaled.type === 'open_url' && scaled.url) {
              await shell.openExternal(assertSafeUrl(scaled.url))
              await sleep(400)
              await agent!.execute({ type: 'focus_browser' })
            } else if (scaled.type === 'navigate_url' && scaled.url) {
              await agent!.execute(scaled)
              await sleep(1500)
            } else {
              await agent!.execute(scaled)
            }
            await sleep(scaled.type === 'hotkey' ? 300 : 150)
          }
        },
        () => {},
        scope.signal
      )
      timer.split('research agent done')
    } else if (!opts.lowDetail && intent.planRequired) {
      // Multi-step: build plan, execute with verification
      const plan = await buildPlan(effectivePrompt, null, activeWindow, scope.signal)
      timer.split('buildPlan done')
      result = await executePlan(
        plan,
        activeWindow,
        (p, s, w) => callClaude(p, s, w, opts),
        () => agent!.screenshot(),
        async (actions) => {
          const frame = currentFrame()
          let prev: AgentAction | undefined
          for (const action of actions as Action[]) {
            if (scope.cancelled) break
            const scaled = toAgentAction(action, frame)
            if (!(await passesPolicy(scaled, prev))) break
            prev = scaled
            if (scaled.type === 'open_url' && scaled.url) {
              await shell.openExternal(assertSafeUrl(scaled.url))
              await sleep(400)
              await agent!.execute({ type: 'focus_browser' })
            } else if (scaled.type === 'navigate_url' && scaled.url) {
              await agent!.execute(scaled)
              await sleep(1500)
            } else {
              await agent!.execute(scaled)
            }
            await sleep(scaled.type === 'hotkey' ? 300 : 150)
          }
        },
        (progress) => {
          const p = progress as { stepIndex?: number; totalSteps?: number; description?: string; status?: string }
          if (p.stepIndex && p.totalSteps && p.description) {
            const statusKind: StatusKind = p.status === 'failed' ? 'error' : 'step'
            setStatus(statusKind, p.description, { index: p.stepIndex, total: p.totalSteps })
          }
        },
        scope.signal
      )
      timer.split('executePlan done')
      // Plan already executed every step. Strip any trailing follow_up so the renderer
      // doesn't fire an extra query that would re-trigger actions outside the plan.
      if (result.mode === 'action' && result.follow_up) {
        log('plan', 'stripping trailing follow_up from planned result')
        delete result.follow_up
      }
    } else {
      result = correctNthElement(await callClaude(effectivePrompt, screenshot, activeWindow, opts))
      timer.split('callClaude done')
    }

    log('done', `mode: ${result.mode}`)
    timer.total()
    // Nothing from a cancelled turn may reach the screen, TTS or history.
    scope.throwIfCancelled()

    // Locate request → action+navigate+follow_up: AI generates action follow_up, but we need locate.
    // Replace the AI's follow_up with a proper locate query so highlights appear after navigation.
    if (!opts.lowDetail && intent.mode === 'locate' && LOCATE_RE.test(prompt) && result.mode === 'action' && result.follow_up) {
      result.follow_up.query = `The page is loaded. Highlight where the user can find: "${prompt}". Respond ONLY with {"mode":"locate","items":[...]} — each item bbox tightly wraps only the matching visible rows/elements. Do NOT click, navigate, or open anything.`
      console.log('[locate-chain] replaced follow_up with locate query')
    }

    // Fallback: if AI still returns guide for an imperative request, auto-convert to click_bbox
    const IMPERATIVE_RE = /\b(open|click|go to|navigate|select|tap|press)\b/i
    if (result.mode === 'guide' && IMPERATIVE_RE.test(prompt) && !isHowToQuestion(prompt) && result.steps?.some(s => s.bbox)) {
      const best = result.steps.find(s => s.bbox)!
      console.log('[auto-action] guide→action fallback, clicking:', best.label)
      return {
        mode: 'action' as const,
        actions: [{ type: 'click_bbox' as const, bbox: best.bbox!, description: best.target_hint, button: 'left' as const }],
        summary: best.label
      }
    }

    // Start TTS synth early — parallel to renderer showing the answer card
    if (result.mode === 'answer' && result.text?.trim()) {
      const cfgNow = loadConfig()
      if (cfgNow.voice.tts === 'cloud') {
        speakAnswer(result.text.trim(), cfgNow.voice.ttsVoice).catch(e =>
          console.warn('[tts] early synth failed:', (e as Error).message))
      }
    }

    // Save exchange to history (text only — images not stored)
    if (!opts.lowDetail) {
      const summary =
        result.mode === 'answer' ? result.text :
        result.mode === 'action' ? (result.summary ?? `action: ${result.actions?.map(a => a.type).join(', ')}`) :
        result.mode === 'guide' ? `guide: ${result.steps?.map(s => s.label).join(', ')}` :
        result.mode === 'text_insert' ? `inserted text` :
        `located: ${result.items?.map(i => i.label).join(', ')}`
      addToHistory(prompt, summary)
    }

    // Model bboxes are image px; overlays draw in logical px.
    const frame = currentFrame()
    const toScreen = (r: Rect): Rect => physRectToLogical(imageRectToPhys(frame, r))

    if (result.mode === 'locate' && result.items?.length) {
      const validItems = result.items.filter((item) => isUsableRect(item.bbox))
      if (validItems.length === 0) {
        // Nothing found on screen — show the description as an answer
        const desc = result.items[0]?.description || 'Not visible on this page'
        answer.showText(desc)
      } else {
        const screenItems = validItems.map((item) => ({ ...item, bbox: toScreen(item.bbox) }))
        highlight.send('screen:locate', screenItems)
        highlight.show()
      }
    } else if (result.mode === 'guide' && result.steps?.some((s) => s.bbox)) {
      const bboxSteps = result.steps
        .filter((s) => s.bbox)
        .map((s) => ({ ...s, bbox: s.bbox ? toScreen(s.bbox) : undefined }))
      activeGuide = { steps: bboxSteps, index: 0 }
      lastGuide = { task: prompt, steps: bboxSteps, savedAt: Date.now() }
      setStatus('step', bboxSteps[0]?.label ?? 'Guide ready', { index: 1, total: bboxSteps.length })
      highlight.send('screen:highlights', bboxSteps)
      highlight.show()

      // Draw the pointer only; moving the real cursor could dismiss the guide.
      const first = bboxSteps[0]
      if (first?.bbox) {
        const c = rectCenter(first.bbox)
        highlight.send('screen:pointer', {
          x: Math.round(c.x), y: Math.round(c.y),
          text: `1/${bboxSteps.length}: ${first.label || first.target_hint}`,
        })
      }
    } else if (result.mode === 'action') {
      const hasRealClick = result.actions?.some((a) =>
        (a.type === 'click' || a.type === 'move') && a.x != null && a.y != null ||
        a.type === 'click_bbox' && a.bbox != null
      )
      if (!hasRealClick) {
        highlight.clear()
      }
    } else {
      highlight.clear()
    }

    return result
  }  // end runQuery





  // Runs actions the renderer confirmed (action mode and follow_up chains).
  async function executeRendererActions(actions: Action[]): Promise<unknown> {
    if (!agent) throw new Error('Agent not ready')
    const scope = beginScope()
    const execTimer = startTimer(`execute-action [${actions.map(a => a.type).join(', ')}]`)
    const frame = currentFrame()
    log('step', `execute: ${actions.map(a => a.type).join(', ')} | image ${frame.imgW}x${frame.imgH} → phys ${frame.width}x${frame.height}`)
    let reachedBottom = false

    let firstClick = true
    let prevAction: AgentAction | undefined
    for (const action of actions) {
      if (scope.cancelled) {
        log('skip', 'execution aborted by user')
        break
      }
      let scaled: AgentAction = toAgentAction(action, frame)

      if (action.type === 'click_bbox' && action.bbox) {
        const physRect = imageRectToPhys(frame, action.bbox)
        let target = rectCenter(physRect)

        // Use Computer Use API for precise coordinates when description is available
        // CU is fine-tuned for UI clicking (~92% accuracy vs ~75% for regular vision)
        if (action.description && process.env.ANTHROPIC_API_KEY) {
          console.log(`[execute] click_bbox CU lookup: "${action.description}"`)
          const freshShot = await agent.screenshot()
          if (freshShot) {
            const refined = await findClickCoordinates(freshShot, action.description, frame.imgW, frame.imgH, scope.signal)
            if (refined) {
              target = imageToPhys(frame, refined)
              console.log(`[execute] click_bbox CU refined → (${target.x},${target.y})`)
            } else {
              console.log('[execute] click_bbox CU returned null, using bbox center')
            }
          }
        }

        // Show bbox highlight on screen before clicking so user can see the target
        highlight.send('screen:highlights', [{
          label: 'Clicking here',
          target_hint: '',
          bbox: physRectToLogical(physRect),
        }])
        highlight.show()
        await sleep(600)
        highlight.hide()
        scaled = { type: 'click', x: Math.round(target.x), y: Math.round(target.y), button: action.button ?? 'left' }
      } else if (action.type === 'click_element' && action.bbox && action.text && process.env.ANTHROPIC_API_KEY) {
        // In browser context: try CU for higher-accuracy click (overrides OCR path)
        const aw = await agent.activeWindow()
        if (isBrowser(aw)) {
          const freshShot = await agent.screenshot()
          if (freshShot) {
            const refined = await findClickCoordinates(freshShot, action.text, frame.imgW, frame.imgH, scope.signal)
            if (refined) {
              const p = imageToPhys(frame, refined)
              console.log(`[execute] click_element CU refined "${action.text}" → (${p.x},${p.y})`)
              scaled = { type: 'click', x: p.x, y: p.y, button: action.button ?? 'left' }
            }
          }
        }
      }

      if (!scaled.type) {
        console.warn('[execute] skipping action with no type:', JSON.stringify(action))
        continue
      }
      console.log('[execute] running:', JSON.stringify(scaled))
      if (!(await passesPolicy(scaled, prevAction))) break
      prevAction = scaled

      if (scaled.type === 'open_url' && scaled.url) {
        console.log('[execute] opening URL:', scaled.url)
        await shell.openExternal(assertSafeUrl(scaled.url))
        await sleep(400)
        await agent.execute({ type: 'focus_browser' })
      } else if (scaled.type === 'navigate_url' && scaled.url) {
        console.log('[execute] navigate_url:', scaled.url)
        await agent.execute(scaled)
        await sleep(1500) // wait for page to finish loading before next action
      } else {
        // Show pointer preview before first click
        if (firstClick && scaled.type === 'click' && scaled.x != null && scaled.y != null) {
          firstClick = false
          highlight.send('screen:pointer', { ...physToLogical({ x: scaled.x, y: scaled.y }), text: 'Clicking here…' })
          highlight.show()
          await sleep(300)
        }
        const actionResult = await agent.execute(scaled) as Record<string, unknown> | null
        if (actionResult?.reached_bottom) {
          console.log('[execute] reached_bottom detected — stopping action loop')
          reachedBottom = true
          break
        }
      }
      await sleep(scaled.type === 'hotkey' ? 300 : 150)
    }

    highlight.hide()
    const aborted = scope.cancelled
    endScope(scope)
    log('done', aborted ? 'execute cancelled' : 'execute complete')
    execTimer.total()
    return { done: !aborted, cancelled: aborted, reached_bottom: reachedBottom }
  }

  registerHudIpc({ armEscape, disarmEscape })
  registerAnswerIpc()
  registerHighlightIpc()
  registerWakeIpc()
  registerVoiceIpc({ speak: speakAnswer, transcribe: transcribeAudio })
  registerGuidesIpc({ saveLast: saveLastAsGuide, replay: replaySavedGuide })
  registerSettingsIpc({
    setHotkey: (combo) => agent?.setHotkey(combo) ?? Promise.resolve(),
    applyListenerState,
    applyDwellState,
  })
  registerQueryIpc({ intercept: interceptGuideCommand, runQuery, execute: executeRendererActions })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) hud.create()
  })
})

app.on('will-quit', () => {
  agent?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Runs the central safety policy on one action. Actions that need confirmation are
// blocked for now (there is no confirm flow yet) and the user is told why.
async function passesPolicy(action: AgentAction, prev?: AgentAction): Promise<boolean> {
  let windowTitle: string | undefined
  if (needsWindowContext(action)) {
    try {
      windowTitle = await agent?.activeWindow()
    } catch {
      /* unknown window, policy treats it as non-shell */
    }
  }
  const { verdict, reason } = checkAction(action, { windowTitle, afterType: prev?.type === 'type' })
  if (verdict === 'allow') return true
  log('fail', `blocked by policy (${verdict}): ${reason ?? action.type}`)
  setStatus('error', `Blocked for safety: ${reason ?? action.type}`, undefined, 3000)
  return false
}

// Active window + optional screenshot. Lumen's own highlight layer is hidden first so it
// is not in the image; the foreground app is never changed.
async function captureContext(withScreenshot: boolean): Promise<QueryContext> {
  if (!agent) throw new Error('Agent not ready')
  if (!withScreenshot) return { activeWindow: await agent.activeWindow(), screenshot: null }
  if (highlight.isVisible()) {
    highlight.hide()
    await sleep(32)
  }
  const [activeWindow, screenshot] = await Promise.all([agent.activeWindow(), agent.screenshot()])
  return { activeWindow, screenshot }
}

function armEscape(): void {
  if (!globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', onEscape)
}

function disarmEscape(): void {
  globalShortcut.unregister('Escape')
}

// Escape cancels in-flight work in main directly and tells the HUD to stop recording.
function onEscape(): void {
  cancelAll()
  bus.emit({ type: 'voice.cancelled' })
}

