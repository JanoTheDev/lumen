import { config } from 'dotenv'
import { join } from 'path'
// Keys are read at runtime, never baked into the bundle. Dev: repo .env. Installed: userData/.env.
config({ path: join(process.cwd(), '.env'), quiet: true })
try {
  config({ path: join(app.getPath('userData'), '.env'), quiet: true })
} catch {
  /* userData unavailable this early on some setups; repo .env still applies */
}

import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage
} from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type { Action, Rect } from '@shared/types'
import { callClaude, needsScreenshot, warmupConnection, addToHistory, findClickCoordinates, detectRequestedApp, isBrowser, type CallOptions, type ClaudeResponse } from './claude'
import { correctNthElement } from './nth-utils'
import { AgentBridge } from './agent-bridge'
import OpenAI, { toFile } from 'openai'
import { classifyQuery, isResearchIntent } from './query-classifier'
import { buildPlan, executePlan, runResearchAgent } from './task-planner'
import { log, startTimer } from './logger'
import { TaskQueue } from './task-queue'
import { splitSubtasks, canParallelize, mergeAnswers } from './task-splitter'
import { loadConfig, saveConfig, configPath, type AppConfig } from './config'
import { modelInstalled, installModel, modelRoot } from './wake-model'
import type { ZodType, infer as zInfer } from 'zod'
import {
  parsePayload,
  promptSchema,
  queryOptsSchema,
  textSchema,
  nameSchema,
  guideIdSchema,
  confidenceSchema,
  overlayHeightSchema,
  audioSchema,
  actionsSchema,
} from '@shared/ipc'
import { configPatchSchema } from '@shared/config'
import { saveGuide, listSavedGuides, deleteSavedGuide, loadSavedGuide, findGuideByName, type GuideStep, type SavedGuide } from './guides/store'
import { parseGuideNav, isReplayRequest, matchSaveGuide, matchPlayGuide, isHowToQuestion } from './guides/voice-nav'
import { beginScope, endScope, cancelAll, isAbortError, type CancelScope } from './query/cancel'
import { startSpeculativeCapture, takeSpeculative, type QueryContext } from './query/context'
import { currentFrame, normalizeBbox, imageRectToPhys, imageToPhys, physRectToLogical, physToLogical, rectCenter, isUsableRect } from './actions/coords'
import { toAgentAction, type AgentAction } from './actions/agent-action'
import trayIcon from '../../resources/icon.png?asset'
import { createWindow, loadRenderer, isOwnRendererUrl } from './windows/factory'
import { assertSafeUrl, isSafeUrl, checkAction, needsWindowContext } from './actions/safety'

let hudWindow: BrowserWindow | null = null
let highlightWindow: BrowserWindow | null = null
let answerOverlayWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let statusWindow: BrowserWindow | null = null
let dwellRingWindow: BrowserWindow | null = null
let tray: Tray | null = null
let agent: AgentBridge | null = null

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = createWindow({
    width: 860,
    height: 620,
    minWidth: 720,
    minHeight: 520,
    title: 'Lumen Settings',
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0b10',
    resizable: true,
    show: false
  })
  settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  loadRenderer(settingsWindow, 'settings')
  settingsWindow.on('closed', () => { settingsWindow = null })
}

function cancelPhraseList(cfg: AppConfig): string[] {
  if (!cfg.cancelVoice.enabled) return []
  return cfg.cancelVoice.phrases.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
}

function applyDwellState(cfg: AppConfig): void {
  if (!agent) return
  if (cfg.dwellClick.enabled) {
    agent.enableDwell(cfg.dwellClick.dwellMs, cfg.dwellClick.cooldownMs).catch(e =>
      console.error('[dwell] enable failed:', (e as Error).message))
    if (dwellRingWindow && !dwellRingWindow.isDestroyed() && !dwellRingWindow.isVisible()) {
      dwellRingWindow.showInactive()
    }
  } else {
    agent.disableDwell().catch(() => {})
    if (dwellRingWindow && !dwellRingWindow.isDestroyed()) dwellRingWindow.hide()
  }
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

function broadcastConfig(cfg: AppConfig): void {
  for (const win of [hudWindow, answerOverlayWindow, highlightWindow, settingsWindow, statusWindow, dwellRingWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', cfg)
  }
  applyUiScale(cfg.uiScale)
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
  answerOverlayWindow?.webContents.send('voice:tts-audio', { mime: 'audio/mpeg', data: b64 })
}

function applyUiScale(scale: number): void {
  const s = Math.max(0.75, Math.min(1.6, scale || 1))
  // Only zoom overlays the user-facing chrome sits on; keep settings/highlight at 1.
  for (const win of [hudWindow, answerOverlayWindow, statusWindow]) {
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(s)
  }
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(trayIcon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Lumen')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Settings', click: () => createSettingsWindow() },
    { label: 'Open config folder', click: () => shell.showItemInFolder(configPath()) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
  tray.on('click', () => createSettingsWindow())
}

function createHUDWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = 100
  const h = 44

  hudWindow = createWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: height - h - 32,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: true
  })
  // Start invisible — use opacity instead of hide/show so Chromium never
  // suspends the renderer (which pauses audio tracks and kills recording)
  hudWindow.setOpacity(0)
  hudWindow.setIgnoreMouseEvents(true)

  hudWindow.webContents.on('did-finish-load', () => {
    if (is.dev) hudWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  loadRenderer(hudWindow, 'index')
}

function createStatusWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = 420
  const h = 44

  statusWindow = createWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: height - h - 78,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: false,
    hasShadow: false
  })
  statusWindow.setIgnoreMouseEvents(true)

  loadRenderer(statusWindow, 'status')
}

function createDwellRingWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().bounds
  dwellRingWindow = createWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: false,
    hasShadow: false
  })
  dwellRingWindow.setIgnoreMouseEvents(true, { forward: false })

  const forceTop = (): void => {
    if (!dwellRingWindow || dwellRingWindow.isDestroyed()) return
    try {
      // Cycle + stack on Windows: toggling off then on with a high relative level
      // forces Windows to re-evaluate z-order above the taskbar's HWND_TOPMOST.
      dwellRingWindow.setAlwaysOnTop(false)
      dwellRingWindow.setAlwaysOnTop(true, 'screen-saver', 1)
      dwellRingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      dwellRingWindow.moveTop()
    } catch { /* noop */ }
  }

  dwellRingWindow.webContents.once('did-finish-load', () => {
    if (dwellRingWindow && !dwellRingWindow.isDestroyed() && loadConfig().dwellClick.enabled) {
      dwellRingWindow.showInactive()
      forceTop()
    }
  })
  // Re-apply each time the app gains focus (OS sometimes resets z-order)
  app.on('browser-window-focus', () => forceTop())

  loadRenderer(dwellRingWindow, 'dwellring')
}

type StatusKind = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'acting' | 'answer' | 'error' | 'step'

let statusHideTimer: ReturnType<typeof setTimeout> | null = null

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
  hudWindow?.webContents.send('assistant:run-query', entry.task)
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
      highlightWindow?.webContents.send('screen:highlights', [step])
      highlightWindow?.show()
      const c = rectCenter(step.bbox)
      highlightWindow?.webContents.send('screen:pointer', {
        x: Math.round(c.x),
        y: Math.round(c.y),
        text: `${clamped + 1}/${total}: ${step.label}`,
      })
    }
  }

  const cmd = parseGuideNav(text)
  if (cmd === 'done') {
    activeGuide = null
    highlightWindow?.hide()
    highlightWindow?.webContents.send('screen:clear')
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

function setStatus(kind: StatusKind, text: string, step?: { index: number; total: number }, autoHideMs?: number): void {
  if (!loadConfig().statusBubble.enabled) return
  if (!statusWindow || statusWindow.isDestroyed()) return
  if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = null }
  statusWindow.showInactive()
  statusWindow.webContents.send('status:set', { kind, text, step })
  if (autoHideMs && autoHideMs > 0) {
    statusHideTimer = setTimeout(() => hideStatus(), autoHideMs)
  }
}

function hideStatus(): void {
  if (!statusWindow || statusWindow.isDestroyed()) return
  statusWindow.webContents.send('status:hide')
  // Tracked so a setStatus during the fade-out cancels the hide.
  statusHideTimer = setTimeout(() => {
    statusHideTimer = null
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide()
  }, 220)
}

function createAnswerOverlayWindow(): void {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  answerOverlayWindow = createWindow({
    width: 360,
    height: 220,
    x: width - 376,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false
  })
  answerOverlayWindow.setIgnoreMouseEvents(false)

  loadRenderer(answerOverlayWindow, 'answeroverlay')
}

function createHighlightWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().bounds

  highlightWindow = createWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false
  })
  highlightWindow.setIgnoreMouseEvents(true)

  loadRenderer(highlightWindow, 'highlight')
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
  ipcMain.on('assistant:open-link', (_e, url: unknown) => {
    if (!isSafeUrl(url)) {
      log('fail', `blocked link: ${String(url).slice(0, 200)}`)
      return
    }
    shell.openExternal(assertSafeUrl(url)).catch(() => {})
  })

  createHUDWindow()
  createHighlightWindow()
  createAnswerOverlayWindow()
  createStatusWindow()
  createDwellRingWindow()
  createTray()
  // Apply saved UI scale once windows finish loading
  const scaleCfg = loadConfig().uiScale
  const winsForScale = [hudWindow, answerOverlayWindow, statusWindow]
  for (const w of winsForScale) {
    if (!w) continue
    w.webContents.once('did-finish-load', () => {
      if (!w.isDestroyed()) w.webContents.setZoomFactor(Math.max(0.75, Math.min(1.6, scaleCfg || 1)))
    })
  }

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
    if (!globalShortcut.isRegistered('Escape')) {
      globalShortcut.register('Escape', onEscape)
    }
    hudWindow?.setOpacity(1)
    hudWindow?.setIgnoreMouseEvents(false)
    if (handsFree) {
      // Tap-to-talk: same auto-stop-on-silence path as wake-word activation
      hudWindow?.webContents.executeJavaScript('window.__wakeVoiceStart?.()', true).catch(() => {})
      setStatus('listening', 'Listening (hands-free)…')
    } else {
      hudWindow?.webContents.executeJavaScript('window.__voiceStart?.()', true).catch(() => {})
      setStatus('listening', 'Listening…')
    }
  })

  // Lumen's own visible windows, compared in logical px.
  const isOverOwnWindow = (pt: { x: number; y: number }): boolean =>
    [hudWindow, answerOverlayWindow, statusWindow, settingsWindow].some((w) => {
      if (!w || w.isDestroyed() || !w.isVisible()) return false
      const b = w.getBounds()
      return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
    })
  let lastRingRaise = 0

  agent.onEvent('dwell-progress', (data) => {
    if (!loadConfig().dwellClick.enabled) return
    if (!dwellRingWindow || dwellRingWindow.isDestroyed()) return
    const xPhys = data?.x as number | undefined
    const yPhys = data?.y as number | undefined
    if (typeof xPhys !== 'number' || typeof yPhys !== 'number') return
    // The agent reports physical px; the ring window draws in logical px.
    const pt = physToLogical({ x: xPhys, y: yPhys })
    if (isOverOwnWindow(pt)) return
    // Re-raise at most every 2s so the ring stays above the taskbar without churning z-order.
    const now = Date.now()
    if (now - lastRingRaise > 2000) {
      lastRingRaise = now
      try { dwellRingWindow.moveTop() } catch { /* noop */ }
    }
    dwellRingWindow.webContents.send('screen:dwell', { ...data, x: Math.round(pt.x), y: Math.round(pt.y) })
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
      hudWindow?.webContents.send('assistant:cancel-request')
      activeGuide = null
      highlightWindow?.hide()
      highlightWindow?.webContents.send('screen:clear')
    }
  })

  agent.onEvent('wake-detected', () => {
    console.log('[wake] detected — showing HUD, starting recording with VAD auto-stop')
    if (!globalShortcut.isRegistered('Escape')) {
      globalShortcut.register('Escape', onEscape)
    }
    hudWindow?.setOpacity(1)
    hudWindow?.setIgnoreMouseEvents(false)
    hudWindow?.webContents.executeJavaScript('window.__wakeVoiceStart?.()', true).catch(() => {})
    setStatus('listening', 'Wake word detected — listening…')
  })

  agent.onEvent('hotkey-up', () => {
    if (loadConfig().handsFreeMode) {
      // In hands-free mode the VAD loop stops recording automatically; ignore release.
      return
    }
    console.log('[hotkey] up — stopping recording, keeping HUD visible until query done')
    hudWindow?.webContents.executeJavaScript('window.__voiceStop?.()', true).catch(() => {})
    setStatus('transcribing', 'Transcribing', { index: 1, total: 3 })
    // Capture while speech is transcribed; runQuery awaits this promise if it is fresh.
    startSpeculativeCapture(() => captureContext(true))
  })

  ipcMain.on('assistant:close', () => {
    globalShortcut.unregister('Escape')
    hudWindow?.setOpacity(0)
    hudWindow?.setIgnoreMouseEvents(true)
    hideStatus()
  })

  ipcMain.on('assistant:show', () => {
    if (!globalShortcut.isRegistered('Escape')) {
      globalShortcut.register('Escape', onEscape)
    }
    hudWindow?.setOpacity(1)
    hudWindow?.setIgnoreMouseEvents(false)
  })

  agent.onEvent('mouse-moved', () => {
    if (!loadConfig().guideAutoDismissOnMove) return
    highlightWindow?.hide()
    highlightWindow?.webContents.send('screen:clear')
    activeGuide = null
  })

  ipcMain.on('answer:show', (_e, raw: unknown) => {
    const text = safeParse('answer:show', textSchema, raw)
    if (text === undefined) return
    answerOverlayWindow?.webContents.send('answer:text', text)
    answerOverlayWindow?.show()
    // NOTE: TTS is kicked off inside runQuery (earlier) to minimize perceived delay.
  })
  ipcMain.handle('voice:speak', async (_e, raw: unknown) => {
    const text = safeParse('voice:speak', textSchema, raw)
    if (text === undefined) return INVALID
    const cfg = loadConfig()
    if (!text || !text.trim()) return { ok: false, error: 'empty text' }
    try {
      await speakAnswer(text.trim(), cfg.tts.voice)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.on('answer:hide', () => {
    answerOverlayWindow?.hide()
  })

  ipcMain.on('answer:resize', (_e, raw: unknown) => {
    const h = safeParse('answer:resize', overlayHeightSchema, raw)
    if (h === undefined) return
    answerOverlayWindow?.setSize(360, h)
  })

  let lastTaskContext: string | null = null
  const userQueue = new TaskQueue(1, 'request-queue')

  ipcMain.on('assistant:cancel', () => {
    if (cancelAll()) log('skip', 'cancel-current received — aborting in-flight work')
  })

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

    // Ordinal list requests (open my 3rd email, 2nd result, etc.) MUST use navigate_url+follow_up.
    // AI ignores rule from system prompt alone — inject a hard override into the prompt.
    const ORDINAL_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(st|nd|rd|th))\b.{0,40}(email|mail|message|result|item|tweet|post|notification)/i
    // Direct "open/click this/that" requests — AI keeps returning guide mode despite rule. Force action.
    const DIRECT_ACTION_RE = /\b(open|click|go to|navigate to|tap|select|press)\s+(this|that|it|the)\b/i
    // Locate/show queries — AI ignores cluster-splitting rule, inject hard override.
    const LOCATE_RE = /\b(show me|where is|where are|find|highlight|point to|locate|can you show)\b/i

    // Classify intent on the ORIGINAL prompt — SYSTEM OVERRIDE injections add verbs that
    // falsely inflate actionVerbCount → planRequired=true for single-shot queries.
    const intent = classifyQuery(prompt)

    let effectivePrompt = prompt
    // App-switch detection: if the user named an app (Gmail, LinkedIn, etc.) and we're
    // not already on it, force the first action to navigate there. Prevents AI from
    // guiding on the current (wrong) page.
    const requestedApp = !opts.lowDetail ? detectRequestedApp(prompt, activeWindow) : null
    if (requestedApp) {
      log('plan', `app-switch detected: ${requestedApp.app} → ${requestedApp.url}`)
      effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: User asked about "${requestedApp.app}" but the active window is "${activeWindow}". You MUST respond with action mode. FIRST action: {"type":"open_url","url":"${requestedApp.url}"}. If further actions are needed after the page loads, put them in follow_up. NEVER return guide mode for an app that isn't currently visible.]`
    }
    if (!opts.lowDetail) {
      if (ORDINAL_RE.test(prompt)) {
        effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: ordinal list request detected. Your response MUST be navigate_url to the list page + follow_up. Do NOT click directly. In follow_up use click_bbox with the exact row bounding box.]`
      } else if (DIRECT_ACTION_RE.test(prompt)) {
        effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: Direct click/open request. You MUST respond with action mode. Use click_bbox with the exact bbox of the target element visible in the screenshot. NEVER use guide mode for this request.]`
      } else if (LOCATE_RE.test(prompt) && intent.mode === 'locate') {
        // Only apply locate override when classifier also said locate. Research intents
        // ("show me positions for X") are action+planner — they must NOT take this path.
        effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: This is a highlight/locate request. TWO CASES:\n1. Target content IS visible in current screenshot → respond ONLY with {"mode":"locate","items":[...]}. The target must be the EXACT CONTENT asked about (e.g. actual email rows from a sender) — NOT shortcuts, icons, bookmarks, or launcher tiles that would navigate to that content. CLUSTER RULE: if matching elements appear in 2+ separate groups with unrelated rows between, return ONE item per group.\n2. Target is NOT visible (wrong page, wrong tab, new tab page, or only a shortcut/icon is visible but not the actual content) → use action mode to navigate_url to the correct page, with follow_up:"The page is loaded. Highlight where the user can find: ${prompt}. Respond ONLY with locate mode." NEVER return locate with bbox [0,0,0,0].]`
      }
    }

    // Continuation: user said "do it" after AI gave answer — re-run with original task
    if (intent.isContinuation && lastTaskContext) {
      log('plan', `continuation detected, re-running: "${lastTaskContext}"`)
      effectivePrompt = `${lastTaskContext}\n\n[User confirmed: proceed with action mode. Execute the task now.]`
    }

    // Store task context for potential continuation (not for low-detail follow-up queries)
    if (!opts.lowDetail && !intent.isContinuation) {
      lastTaskContext = effectivePrompt
    }

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
        (progress) => { hudWindow?.webContents.send('plan-progress', progress) },
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
          hudWindow?.webContents.send('plan-progress', progress)
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
      if (cfgNow.tts.enabled) {
        speakAnswer(result.text.trim(), cfgNow.tts.voice).catch(e =>
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
        answerOverlayWindow?.webContents.send('answer:text', desc)
        answerOverlayWindow?.show()
      } else {
        const screenItems = validItems.map((item) => ({ ...item, bbox: toScreen(item.bbox) }))
        highlightWindow?.webContents.send('screen:locate', screenItems)
        highlightWindow?.show()
      }
    } else if (result.mode === 'guide' && result.steps?.some((s) => s.bbox)) {
      const bboxSteps = result.steps
        .filter((s) => s.bbox)
        .map((s) => ({ ...s, bbox: s.bbox ? toScreen(s.bbox) : undefined }))
      activeGuide = { steps: bboxSteps, index: 0 }
      lastGuide = { task: prompt, steps: bboxSteps, savedAt: Date.now() }
      setStatus('step', bboxSteps[0]?.label ?? 'Guide ready', { index: 1, total: bboxSteps.length })
      highlightWindow?.webContents.send('screen:highlights', bboxSteps)
      highlightWindow?.show()

      // Draw the pointer only; moving the real cursor could dismiss the guide.
      const first = bboxSteps[0]
      if (first?.bbox) {
        const c = rectCenter(first.bbox)
        highlightWindow?.webContents.send('screen:pointer', {
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
        highlightWindow?.hide()
        highlightWindow?.webContents.send('screen:clear')
      }
    } else {
      highlightWindow?.hide()
      highlightWindow?.webContents.send('screen:clear')
    }

    return result
  }  // end runQuery

  ipcMain.handle('assistant:query', async (_event, rawPrompt: unknown, rawOpts: unknown) => {
    const prompt = safeParse('assistant:query', promptSchema, rawPrompt)
    const opts: CallOptions | undefined = safeParse('assistant:query', queryOptsSchema, rawOpts) ?? {}
    if (prompt === undefined) return INVALID
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
      highlightWindow?.webContents.send('screen:highlights', lastGuide.steps)
      highlightWindow?.show()
      return { mode: 'answer', text: `Replaying guide: "${lastGuide.task}" (${lastGuide.steps.length} steps). Say "next" to advance.` }
    }
    setStatus('thinking', 'Thinking', { index: 2, total: 3 })
    const scope = beginScope()
    try {
      // Level 2: split read-only prompts into parallel subtasks.
      if (!opts.lowDetail) {
        const subtasks = splitSubtasks(prompt)
        if (canParallelize(subtasks)) {
          const result = await userQueue.enqueue(`parallel (${subtasks.length}) "${prompt.slice(0, 40)}"`, async () => {
            log('plan', `parallel subtasks: ${subtasks.length} — ${subtasks.map(s => `"${s.slice(0, 30)}"`).join(', ')}`)
            const timer = startTimer(`parallel subtasks (${subtasks.length})`)
            const answers = await Promise.all(subtasks.map(st => runQuery(st, opts, scope.child())))
            timer.total()
            const texts = answers.map(a => (a.mode === 'answer' ? a.text : JSON.stringify(a)))
            return { mode: 'answer' as const, text: mergeAnswers(subtasks, texts) }
          })
          setStatus('answer', 'Done', undefined, 1400)
          return result
        }
      }

      // Level 1: serialize user requests through the queue.
      const result = await userQueue.enqueue(`"${prompt.slice(0, 40)}"`, () => runQuery(prompt, opts, scope))
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
    }
  })

  ipcMain.handle('assistant:announce', async (_event, rawSummary: unknown, rawConfidence: unknown) => {
    const summary = safeParse('assistant:announce', textSchema, rawSummary)
    const confidence = safeParse('assistant:announce', confidenceSchema, rawConfidence)
    if (summary === undefined) return { delayMs: 0 }
    const cfg = loadConfig()
    if (!cfg.explainBeforeDo && !cfg.showConfidence) return { delayMs: 0 }
    if (!summary || !summary.trim()) return { delayMs: 0 }
    const conf = (confidence ?? 'high') as 'high' | 'medium' | 'low'
    const baseText = `About to: ${summary.trim()}`
    const displayText = cfg.showConfidence && conf !== 'high'
      ? `${conf === 'low' ? '⚠ Low confidence' : '◎ Medium confidence'} — ${baseText}. Say "cancel" to stop.`
      : baseText
    const kind = conf === 'low' ? 'error' : 'acting'
    const delayMs = conf === 'low' ? 2000 : conf === 'medium' ? 1500 : 1200
    setStatus(kind, displayText, undefined, delayMs + 1200)
    return { delayMs: cfg.explainBeforeDo ? delayMs : 0 }
  })

  ipcMain.handle('assistant:execute', async (_event, rawActions: unknown) => {
    const parsed = safeParse('assistant:execute', actionsSchema, rawActions)
    if (!parsed) return INVALID
    const actions = parsed.map((a) => ({ ...a, bbox: a.bbox ? normalizeBbox(a.bbox) ?? undefined : undefined })) as Action[]
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
        highlightWindow?.webContents.send('screen:highlights', [{
          label: 'Clicking here',
          target_hint: '',
          bbox: physRectToLogical(physRect),
        }])
        highlightWindow?.show()
        await sleep(600)
        highlightWindow?.hide()
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
          highlightWindow?.webContents.send('screen:pointer', { ...physToLogical({ x: scaled.x, y: scaled.y }), text: 'Clicking here…' })
          highlightWindow?.show()
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

    highlightWindow?.hide()
    const aborted = scope.cancelled
    endScope(scope)
    log('done', aborted ? 'execute cancelled' : 'execute complete')
    execTimer.total()
    return { done: !aborted, cancelled: aborted, reached_bottom: reachedBottom }
  })

  ipcMain.handle('screen:hide', () => {
    highlightWindow?.hide()
    highlightWindow?.webContents.send('screen:clear')
  })

  ipcMain.handle('settings:get', () => loadConfig())
  ipcMain.handle('settings:patch', async (_e, raw: unknown) => {
    const patch = safeParse('settings:patch', configPatchSchema, raw) as Partial<AppConfig> | undefined
    if (!patch) return INVALID
    const prev = loadConfig()
    const next = saveConfig(patch)
    broadcastConfig(next)
    if (patch.hotkey && patch.hotkey !== prev.hotkey) {
      try {
        await agent?.setHotkey(next.hotkey)
      } catch (e) {
        console.error('[hotkey] rebind failed:', (e as Error).message)
      }
    }
    if (patch.statusBubble && prev.statusBubble.enabled && !next.statusBubble.enabled) {
      hideStatus()
    }
    // Only touch the agent when the relevant settings actually changed.
    const listenerChanged =
      JSON.stringify([prev.wakeWord, prev.cancelVoice]) !== JSON.stringify([next.wakeWord, next.cancelVoice])
    if (listenerChanged) applyListenerState(next)
    if (JSON.stringify(prev.dwellClick) !== JSON.stringify(next.dwellClick)) applyDwellState(next)
    return next
  })

  ipcMain.handle('guides:list', () => listSavedGuides())
  ipcMain.handle('guides:save-last', (_e, raw: unknown) => {
    const name = safeParse('guides:save-last', nameSchema.optional(), raw)
    const g = saveLastAsGuide(name ?? '')
    return g ?? { error: 'no guide to save — run a guide first' }
  })
  ipcMain.handle('guides:replay', (_e, raw: unknown) => {
    const id = safeParse('guides:replay', guideIdSchema, raw)
    return (id && replaySavedGuide(id)) || { error: 'not found' }
  })
  ipcMain.handle('guides:delete', (_e, raw: unknown) => {
    const id = safeParse('guides:delete', guideIdSchema, raw)
    return { ok: !!id && deleteSavedGuide(id) }
  })

  ipcMain.handle('wake:model-status', () => ({
    installed: modelInstalled(),
    path: modelRoot(),
  }))
  ipcMain.handle('wake:model-install', async () => {
    try {
      await installModel()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.on('settings:open', () => createSettingsWindow())
  ipcMain.on('settings:window-close', () => settingsWindow?.close())
  ipcMain.on('settings:window-minimize', () => settingsWindow?.minimize())
  ipcMain.on('settings:window-maximize', () => {
    if (!settingsWindow) return
    if (settingsWindow.isMaximized()) settingsWindow.unmaximize()
    else settingsWindow.maximize()
  })

  ipcMain.handle('voice:transcribe', async (_event, raw: unknown) => {
    const audio = safeParse('voice:transcribe', audioSchema, raw)
    if (!audio) return ''
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
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createHUDWindow()
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
  if (highlightWindow?.isVisible()) {
    highlightWindow.hide()
    await sleep(32)
  }
  const [activeWindow, screenshot] = await Promise.all([agent.activeWindow(), agent.screenshot()])
  return { activeWindow, screenshot }
}

const INVALID = { error: 'E_INVALID' } as const
const CANCELLED = { mode: 'answer', text: 'Cancelled.', cancelled: true } as const

// Escape cancels in-flight work in main directly and tells the HUD to stop recording.
function onEscape(): void {
  cancelAll()
  hudWindow?.webContents.send('assistant:cancel-request')
}

// Validates a renderer payload; logs and returns undefined when it does not match.
function safeParse<T extends ZodType>(channel: string, schema: T, value: unknown): zInfer<T> | undefined {
  try {
    return parsePayload(channel, schema, value)
  } catch (e) {
    log('fail', (e as Error).message)
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
