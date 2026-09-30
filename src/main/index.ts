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
import { warmupConnection } from './claude'
import { AgentBridge } from './agent/bridge'
import OpenAI, { toFile } from 'openai'
import { log } from './logger'
import { loadConfig, lastConfigWarning, type AppConfig } from './config'
import { modelInstalled, installModel } from './wake-model'
import { saveGuide, loadSavedGuide, findGuideByName, type GuideStep, type SavedGuide } from './guides/store'
import { parseGuideNav, isReplayRequest, matchSaveGuide, matchPlayGuide } from './guides/voice-nav'
import { cancelAll } from './query/cancel'
import { startSpeculativeCapture } from './query/context'
import { physToLogical, rectCenter } from './actions/coords'
import { isOwnRendererUrl } from './windows/factory'
import { assertSafeUrl, isSafeUrl } from './actions/safety'
import { bus } from './bus'
import { applyUiScaleOnLoad, isOverOwnWindow } from './windows/registry'
import { setStatus } from './windows/status'
import * as hud from './windows/hud'
import * as statusWin from './windows/status'
import * as answer from './windows/answer'
import * as highlight from './windows/highlight'
import * as dwellRing from './windows/dwell-ring'
import * as tray from './windows/tray'
import { setAgent } from './agent/instance'
import { captureContext, runQuery } from './query/pipeline'
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

function startGuide(task: string, steps: GuideStep[]): void {
  activeGuide = { steps, index: 0 }
  lastGuide = { task, steps, savedAt: Date.now() }
}

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
  setAgent(agent)
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
  registerQueryIpc({
    intercept: interceptGuideCommand,
    runQuery: (prompt, opts, scope) => runQuery(prompt, opts, scope, { speak: speakAnswer, onGuide: startGuide }),
  })

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

