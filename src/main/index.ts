import { config } from 'dotenv'
import { join } from 'path'
config({ path: join(process.cwd(), '.env') })

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
import { writeFileSync, unlinkSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { callClaude, needsScreenshot, screenshotDimensions, warmupConnection, addToHistory, findClickCoordinates, type CallOptions, type ClaudeResponse } from './claude'
import { correctNthElement } from './nth-utils'
import { AgentBridge } from './agent-bridge'
import OpenAI from 'openai'
import { createReadStream } from 'fs'
import { classifyQuery, isResearchIntent } from './query-classifier'
import { buildPlan, executePlan, runResearchAgent } from './task-planner'
import { log, startTimer } from './logger'
import { TaskQueue } from './task-queue'
import { splitSubtasks, canParallelize, mergeAnswers } from './task-splitter'
import { loadConfig, saveConfig, configPath, type AppConfig } from './config'
import { modelInstalled, installModel, modelRoot } from './wake-model'

let hudWindow: BrowserWindow | null = null
let highlightWindow: BrowserWindow | null = null
let answerOverlayWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let statusWindow: BrowserWindow | null = null
let tray: Tray | null = null
let agent: AgentBridge | null = null

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 560,
    title: 'AI Overlay Settings',
    frame: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'))
  }
  settingsWindow.on('closed', () => { settingsWindow = null })
}

function broadcastConfig(cfg: AppConfig): void {
  for (const win of [hudWindow, answerOverlayWindow, highlightWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('config-changed', cfg)
  }
}

function createTray(): void {
  const emptyIcon = nativeImage.createEmpty()
  tray = new Tray(emptyIcon)
  tray.setToolTip('AI Overlay')
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

  hudWindow = new BrowserWindow({
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
    show: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // Start invisible — use opacity instead of hide/show so Chromium never
  // suspends the renderer (which pauses audio tracks and kills recording)
  hudWindow.setOpacity(0)
  hudWindow.setIgnoreMouseEvents(true)

  hudWindow.webContents.on('did-finish-load', () => {
    if (is.dev) hudWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    hudWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    hudWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createStatusWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = 420
  const h = 44

  statusWindow = new BrowserWindow({
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
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  })
  statusWindow.setIgnoreMouseEvents(true)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    statusWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/status.html`)
  } else {
    statusWindow.loadFile(join(__dirname, '../renderer/status.html'))
  }
}

type StatusKind = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'acting' | 'answer' | 'error' | 'step'

let statusHideTimer: ReturnType<typeof setTimeout> | null = null

interface ActiveGuide {
  steps: Array<{ label: string; target_hint: string; bbox?: [number, number, number, number] }>
  index: number
}
let activeGuide: ActiveGuide | null = null

const NAV_NEXT = /\b(next|next step|continue|go on|advance|forward)\b/i
const NAV_PREV = /\b(previous|prev|back|go back|last step)\b/i
const NAV_REPEAT = /\b(repeat|again|say again|what)\b/i
const NAV_DONE = /\b(done|finished|finish|stop|close|dismiss|cancel|exit|never mind)\b/i

function handleGuideNavCommand(prompt: string): { handled: boolean; response?: unknown } {
  if (!activeGuide) return { handled: false }
  const text = prompt.trim()
  if (!text || text.length > 60) return { handled: false }

  const showStep = (idx: number): void => {
    if (!activeGuide) return
    const clamped = Math.max(0, Math.min(activeGuide.steps.length - 1, idx))
    activeGuide.index = clamped
    const step = activeGuide.steps[clamped]
    setStatus('step', step.label, { index: clamped + 1, total: activeGuide.steps.length })
    if (step.bbox) {
      highlightWindow?.webContents.send('show-highlights', [step])
      highlightWindow?.show()
      const [bx, by, bw, bh] = step.bbox
      highlightWindow?.webContents.send('show-pointer', {
        x: Math.round(bx + bw / 2), y: Math.round(by + bh / 2), text: step.label,
      })
    }
  }

  if (NAV_DONE.test(text)) {
    activeGuide = null
    highlightWindow?.hide()
    highlightWindow?.webContents.send('clear-highlights')
    setStatus('idle', 'Guide closed', undefined, 900)
    return { handled: true, response: { mode: 'answer', text: 'Guide closed.' } }
  }
  if (NAV_NEXT.test(text)) {
    if (activeGuide.index >= activeGuide.steps.length - 1) {
      setStatus('answer', 'Last step', undefined, 1400)
      return { handled: true, response: { mode: 'answer', text: 'You are on the last step.' } }
    }
    showStep(activeGuide.index + 1)
    return { handled: true, response: { mode: 'answer', text: `Step ${activeGuide.index + 1}: ${activeGuide.steps[activeGuide.index].label}` } }
  }
  if (NAV_PREV.test(text)) {
    showStep(Math.max(0, activeGuide.index - 1))
    return { handled: true, response: { mode: 'answer', text: `Step ${activeGuide.index + 1}: ${activeGuide.steps[activeGuide.index].label}` } }
  }
  if (NAV_REPEAT.test(text)) {
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
  statusWindow.webContents.send('status-set', { kind, text, step })
  if (autoHideMs && autoHideMs > 0) {
    statusHideTimer = setTimeout(() => hideStatus(), autoHideMs)
  }
}

function hideStatus(): void {
  if (!statusWindow || statusWindow.isDestroyed()) return
  statusWindow.webContents.send('status-hide')
  setTimeout(() => { if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide() }, 220)
}

function createAnswerOverlayWindow(): void {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  answerOverlayWindow = new BrowserWindow({
    width: 360,
    height: 220,
    x: width - 376,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  answerOverlayWindow.setIgnoreMouseEvents(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    answerOverlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/answeroverlay.html`)
  } else {
    answerOverlayWindow.loadFile(join(__dirname, '../renderer/answeroverlay.html'))
  }
}

function createHighlightWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().bounds

  highlightWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  highlightWindow.setIgnoreMouseEvents(true)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    highlightWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/highlight.html`)
  } else {
    highlightWindow.loadFile(join(__dirname, '../renderer/highlight.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.aioverlay')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  agent = new AgentBridge()
  await agent.start()
  const initialCfg = loadConfig()
  try {
    await agent.setHotkey(initialCfg.hotkey)
  } catch (e) {
    console.error('[hotkey] initial bind failed:', (e as Error).message)
  }
  if (initialCfg.wakeWord.enabled && initialCfg.wakeWord.phrase.trim()) {
    if (modelInstalled()) {
      agent.enableWakeWord(initialCfg.wakeWord.phrase).catch(e =>
        console.error('[wake] initial enable failed:', (e as Error).message))
    } else {
      console.log('[wake] enabled but model missing — will install on first settings visit or on toggle')
    }
  }
  warmupConnection()

  createHUDWindow()
  createHighlightWindow()
  createAnswerOverlayWindow()
  createStatusWindow()
  createTray()
  loadConfig()  // warm cache

  agent.onEvent('hotkey-down', () => {
    console.log('[hotkey] down — showing HUD, starting recording')
    if (!globalShortcut.isRegistered('Escape')) {
      globalShortcut.register('Escape', () => {
        hudWindow?.webContents.send('cancel-request')
      })
    }
    hudWindow?.setOpacity(1)
    hudWindow?.setIgnoreMouseEvents(false)
    hudWindow?.webContents.executeJavaScript('window.__voiceStart?.()', true).catch(() => {})
    setStatus('listening', 'Listening…')
  })

  agent.onEvent('wake-detected', () => {
    console.log('[wake] detected — showing HUD, starting recording with VAD auto-stop')
    if (!globalShortcut.isRegistered('Escape')) {
      globalShortcut.register('Escape', () => {
        hudWindow?.webContents.send('cancel-request')
      })
    }
    hudWindow?.setOpacity(1)
    hudWindow?.setIgnoreMouseEvents(false)
    hudWindow?.webContents.executeJavaScript('window.__wakeVoiceStart?.()', true).catch(() => {})
    setStatus('listening', 'Wake word detected — listening…')
  })

  // Speculative screenshot: fire focus+capture immediately on hotkey-up while Whisper transcribes.
  // Query handler uses the cache if it's fresh (< 4s), skipping the 0.8s sequential wait.
  let speculativeShot: { screenshot: string; activeWindow: string; ts: number } | null = null

  agent.onEvent('hotkey-up', () => {
    console.log('[hotkey] up — stopping recording, keeping HUD visible until query done')
    hudWindow?.webContents.executeJavaScript('window.__voiceStop?.()', true).catch(() => {})
    setStatus('transcribing', 'Transcribing…')

    // Fire speculative screenshot in background — don't await
    ;(async () => {
      try {
        // Always focus browser first — brings it to front if something (console, devtools, etc.)
        // is covering it. If no browser is running this is a no-op.
        const focusResult = await agent!.execute({ type: 'focus_browser' } as Action) as { title?: string } | null
        highlightWindow?.hide()
        await sleep(350)
        // Use the title returned by focus_browser (avoids re-querying which may still see cmd.exe)
        const aw = focusResult?.title || await agent!.activeWindow()
        const shot = await agent!.screenshot()
        speculativeShot = { screenshot: shot, activeWindow: aw, ts: Date.now() }
        console.log('[speculative] screenshot ready, activeWindow:', aw)
      } catch (e) {
        console.warn('[speculative] screenshot failed:', (e as Error).message)
      }
    })()
  })

  ipcMain.on('close-hud', () => {
    globalShortcut.unregister('Escape')
    hudWindow?.setOpacity(0)
    hudWindow?.setIgnoreMouseEvents(true)
    hideStatus()
  })

  ipcMain.on('hud-show', () => {
    if (!globalShortcut.isRegistered('Escape')) {
      globalShortcut.register('Escape', () => {
        hudWindow?.webContents.send('cancel-request')
      })
    }
    hudWindow?.setOpacity(1)
    hudWindow?.setIgnoreMouseEvents(false)
  })

  agent.onEvent('mouse-moved', () => {
    highlightWindow?.hide()
    highlightWindow?.webContents.send('clear-highlights')
    activeGuide = null
  })

  ipcMain.on('show-answer-overlay', (_e, text: string) => {
    answerOverlayWindow?.webContents.send('show-answer', text)
    answerOverlayWindow?.show()
  })
  ipcMain.on('hide-answer-overlay', () => {
    answerOverlayWindow?.hide()
  })

  ipcMain.on('resize-answer-overlay', (_e, h: number) => {
    const clamped = Math.max(80, Math.min(Math.round(h), 320))
    answerOverlayWindow?.setSize(360, clamped)
  })

  let lastTaskContext: string | null = null
  let currentAbort: AbortController | null = null
  const userQueue = new TaskQueue(1, 'request-queue')

  ipcMain.on('cancel-current', () => {
    if (currentAbort) {
      log('skip', 'cancel-current received — aborting in-flight query')
      currentAbort.abort()
    }
  })

  async function runQuery(prompt: string, opts: CallOptions): Promise<ClaudeResponse> {
    if (!agent) throw new Error('Agent not ready')
    const abortController = new AbortController()
    currentAbort = abortController
    const timer = startTimer(`query "${prompt.slice(0, 60)}"${opts.lowDetail ? ' [low-detail]' : ''}`)
    log('plan', `prompt: "${prompt}"${opts.lowDetail ? ' [low-detail]' : ''}`)

    const needsShot = needsScreenshot(prompt)
    log('plan', `needs screenshot: ${needsShot}`)

    let activeWindow: string
    let screenshot: string | null

    const SPEC_TTL = 4000  // use speculative cache if taken within 4s
    if (needsShot && speculativeShot && Date.now() - speculativeShot.ts < SPEC_TTL) {
      log('plan', `using speculative screenshot (age: ${Date.now() - speculativeShot.ts}ms)`)
      activeWindow = speculativeShot.activeWindow
      screenshot = speculativeShot.screenshot
      speculativeShot = null
    } else {
      if (needsShot) {
        // Always focus browser — brings it to front if covered by console, devtools, etc.
        // No-op if no browser is running (desktop app scenario unaffected).
        console.log('[query] focusing browser before screenshot')
        const focusResult = await agent.execute({ type: 'focus_browser' } as Action) as { title?: string } | null
        highlightWindow?.hide()
        await sleep(350)
        // Use title from focus_browser — avoids re-querying activeWindow which may still see cmd
        activeWindow = focusResult?.title || await agent.activeWindow()
      } else {
        activeWindow = await agent.activeWindow()
      }
      screenshot = needsShot ? await agent.screenshot() : null
    }
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
          const { scale } = screenshotDimensions()
          for (const action of actions as Action[]) {
            const scaled = scaleActionForAgent(action, scale)
            if (scaled.type === 'open_url' && scaled.url) {
              await shell.openExternal(scaled.url)
              await sleep(400)
              await agent!.execute({ type: 'focus_browser' } as Action)
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
        abortController.signal
      )
      timer.split('research agent done')
    } else if (!opts.lowDetail && intent.planRequired) {
      // Multi-step: build plan, execute with verification
      const plan = await buildPlan(effectivePrompt, null, activeWindow)
      timer.split('buildPlan done')
      result = await executePlan(
        plan,
        activeWindow,
        (p, s, w) => callClaude(p, s, w, opts),
        () => agent!.screenshot(),
        async (actions) => {
          const { scale } = screenshotDimensions()
          for (const action of actions as Action[]) {
            const scaled = scaleActionForAgent(action, scale)
            if (scaled.type === 'open_url' && scaled.url) {
              await shell.openExternal(scaled.url)
              await sleep(400)
              await agent!.execute({ type: 'focus_browser' } as Action)
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
        }
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

    // Locate request → action+navigate+follow_up: AI generates action follow_up, but we need locate.
    // Replace the AI's follow_up with a proper locate query so highlights appear after navigation.
    if (!opts.lowDetail && intent.mode === 'locate' && LOCATE_RE.test(prompt) && result.mode === 'action' && result.follow_up) {
      result.follow_up.query = `The page is loaded. Highlight where the user can find: "${prompt}". Respond ONLY with {"mode":"locate","items":[...]} — each item bbox tightly wraps only the matching visible rows/elements. Do NOT click, navigate, or open anything.`
      console.log('[locate-chain] replaced follow_up with locate query')
    }

    // Fallback: if AI still returns guide for an imperative request, auto-convert to click_bbox
    const IMPERATIVE_RE = /\b(open|click|go to|navigate|select|tap|press)\b/i
    if (result.mode === 'guide' && IMPERATIVE_RE.test(prompt) && result.steps?.some(s => s.bbox)) {
      const best = result.steps.find(s => s.bbox)!
      console.log('[auto-action] guide→action fallback, clicking:', best.label)
      return {
        mode: 'action' as const,
        actions: [{ type: 'click_bbox' as const, bbox: best.bbox!, description: best.target_hint, button: 'left' as const }],
        summary: best.label
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

    const { scale } = screenshotDimensions()

    if (result.mode === 'locate' && result.items?.length) {
      // Filter out zero-dimension bboxes (AI "not found" sentinel — [0,0,0,0] or similar)
      const validItems = result.items.filter(item => {
        const [x1, y1, x2, y2] = item.bbox
        return (x2 - x1) > 4 && (y2 - y1) > 4
      })
      if (validItems.length === 0) {
        // Nothing found on screen — show the description as an answer
        const desc = result.items[0]?.description || 'Not visible on this page'
        answerOverlayWindow?.webContents.send('show-answer', desc)
        answerOverlayWindow?.show()
      } else {
        const scaledItems = validItems.map(item => {
          const [x1, y1, x2, y2] = item.bbox
          return {
            label: item.label,
            bbox: [Math.round(x1 * scale), Math.round(y1 * scale), Math.round((x2 - x1) * scale), Math.round((y2 - y1) * scale)] as [number, number, number, number],
            description: item.description
          }
        })
        highlightWindow?.webContents.send('show-locate', scaledItems)
        highlightWindow?.show()
      }
    } else if (result.mode === 'guide' && result.steps?.some((s) => s.bbox)) {
      const bboxSteps = result.steps.filter((s) => s.bbox).map((s) => ({
        ...s,
        bbox: s.bbox ? [
          Math.round(s.bbox[0] * scale), Math.round(s.bbox[1] * scale),
          Math.round(s.bbox[2] * scale), Math.round(s.bbox[3] * scale)
        ] as [number, number, number, number] : undefined
      }))
      activeGuide = { steps: bboxSteps, index: 0 }
      setStatus('step', bboxSteps[0]?.label ?? 'Guide ready', { index: 1, total: bboxSteps.length })
      highlightWindow?.webContents.send('show-highlights', bboxSteps)
      highlightWindow?.show()

      const first = bboxSteps[0]
      if (first?.bbox) {
        const [bx, by, bw, bh] = first.bbox
        const cx = Math.round(bx + bw / 2)
        const cy = Math.round(by + bh / 2)
        await agent.execute({ type: 'move', x: cx, y: cy })
        highlightWindow?.webContents.send('show-pointer', {
          x: cx, y: cy, text: first.label || first.target_hint
        })
      }
    } else if (result.mode === 'action') {
      const hasRealClick = result.actions?.some((a) =>
        (a.type === 'click' || a.type === 'move') && a.x != null && a.y != null ||
        a.type === 'click_bbox' && a.bbox != null
      )
      if (!hasRealClick) {
        highlightWindow?.hide()
        highlightWindow?.webContents.send('clear-highlights')
      }
    } else {
      highlightWindow?.hide()
      highlightWindow?.webContents.send('clear-highlights')
    }

    if (currentAbort === abortController) currentAbort = null
    return result
  }  // end runQuery

  ipcMain.handle('query', async (_event, prompt: string, opts: CallOptions = {}) => {
    // Guide voice nav: "next step", "back", "repeat", "done"
    const nav = handleGuideNavCommand(prompt)
    if (nav.handled) return nav.response
    setStatus('thinking', 'Thinking…')
    try {
      // Level 2: split read-only prompts into parallel subtasks.
      if (!opts.lowDetail) {
        const subtasks = splitSubtasks(prompt)
        if (canParallelize(subtasks)) {
          const result = await userQueue.enqueue(`parallel (${subtasks.length}) "${prompt.slice(0, 40)}"`, async () => {
            log('plan', `parallel subtasks: ${subtasks.length} — ${subtasks.map(s => `"${s.slice(0, 30)}"`).join(', ')}`)
            const timer = startTimer(`parallel subtasks (${subtasks.length})`)
            const answers = await Promise.all(subtasks.map(st => runQuery(st, opts)))
            timer.total()
            const texts = answers.map(a => (a.mode === 'answer' ? a.text : JSON.stringify(a)))
            return { mode: 'answer' as const, text: mergeAnswers(subtasks, texts) }
          })
          setStatus('answer', 'Done', undefined, 1400)
          return result
        }
      }

      // Level 1: serialize user requests through the queue.
      const result = await userQueue.enqueue(`"${prompt.slice(0, 40)}"`, () => runQuery(prompt, opts))
      const modeLabel = (result as { mode?: string }).mode
      if (modeLabel === 'action') setStatus('acting', 'Executing action…', undefined, 2000)
      else if (modeLabel === 'guide') setStatus('step', 'Guide ready', undefined, 2500)
      else setStatus('answer', 'Done', undefined, 1400)
      return result
    } catch (e) {
      setStatus('error', `Error: ${(e as Error).message}`, undefined, 3000)
      throw e
    }
  })

  ipcMain.handle('execute-action', async (_event, actions: Action[]) => {
    if (!agent) throw new Error('Agent not ready')
    const execTimer = startTimer(`execute-action [${actions.map(a => a.type).join(', ')}]`)
    const { scale } = screenshotDimensions()
    log('step', `execute: ${actions.map(a => a.type).join(', ')} | scale: ${scale}`)
    let reachedBottom = false

    let firstClick = true
    for (const action of actions) {
      let scaled: Action

      if (action.type === 'scroll') {
        const cappedAmount = action.amount != null ? Math.min(Math.max(1, action.amount), 2) : 1
        const base = { ...action, amount: cappedAmount }
        scaled = base.x != null && base.y != null
          ? { ...base, x: Math.round(base.x * scale), y: Math.round(base.y * scale) } as Action
          : base as Action
      } else if (action.type === 'click_bbox' && action.bbox) {
        const [x1, y1, x2, y2] = action.bbox
        const sx1 = Math.round(x1 * scale), sy1 = Math.round(y1 * scale)
        const sx2 = Math.round(x2 * scale), sy2 = Math.round(y2 * scale)
        let cx = Math.round((sx1 + sx2) / 2)
        let cy = Math.round((sy1 + sy2) / 2)

        // Use Computer Use API for precise coordinates when description is available
        // CU is fine-tuned for UI clicking (~92% accuracy vs ~75% for regular vision)
        if (action.description && process.env.ANTHROPIC_API_KEY) {
          console.log(`[execute] click_bbox CU lookup: "${action.description}"`)
          const freshShot = await agent.screenshot()
          if (freshShot) {
            const { imgW, imgH } = screenshotDimensions()
            const refined = await findClickCoordinates(freshShot, action.description, imgW, imgH)
            if (refined) {
              cx = Math.round(refined.x * scale)
              cy = Math.round(refined.y * scale)
              console.log(`[execute] click_bbox CU refined → (${cx},${cy})`)
            } else {
              console.log(`[execute] click_bbox CU returned null, using bbox center (${cx},${cy})`)
            }
          }
        }

        // Show bbox highlight on screen before clicking so user can see the target
        highlightWindow?.webContents.send('show-highlights', [{
          label: 'Clicking here',
          target_hint: '',
          bbox: [sx1, sy1, sx2 - sx1, sy2 - sy1] as [number, number, number, number]
        }])
        highlightWindow?.show()
        console.log(`[execute] click_bbox screen rect: (${sx1},${sy1})→(${sx2},${sy2}) center:(${cx},${cy}) [${Math.round(cx/scale*100/1280)}% x ${Math.round(cy/scale*100/720)}%]`)
        await sleep(600)
        highlightWindow?.hide()
        scaled = { type: 'click', x: cx, y: cy, button: action.button ?? 'left' }
      } else if ((action.type === 'click' || action.type === 'move') && action.x != null && action.y != null) {
        scaled = { ...action, x: Math.round(action.x * scale), y: Math.round(action.y * scale) }
      } else if (action.type === 'click_element' && action.bbox) {
        // Scale the bbox fallback coords from screenshot space to screen space
        const [x1, y1, x2, y2] = action.bbox
        scaled = {
          ...action,
          bbox: [Math.round(x1 * scale), Math.round(y1 * scale), Math.round(x2 * scale), Math.round(y2 * scale)]
        } as Action
      } else {
        scaled = action
      }

      if (!scaled.type) {
        console.warn('[execute] skipping action with no type:', JSON.stringify(action))
        continue
      }
      console.log('[execute] running:', JSON.stringify(scaled))

      if (scaled.type === 'open_url' && scaled.url) {
        console.log('[execute] opening URL:', scaled.url)
        await shell.openExternal(scaled.url)
        await sleep(400)
        await agent.execute({ type: 'focus_browser' } as Action)
      } else if (scaled.type === 'navigate_url' && scaled.url) {
        console.log('[execute] navigate_url:', scaled.url)
        await agent.execute(scaled)
        await sleep(1500) // wait for page to finish loading before next action
      } else {
        // Show pointer preview before first click
        if (firstClick && scaled.type === 'click' && scaled.x != null && scaled.y != null) {
          firstClick = false
          highlightWindow?.webContents.send('show-pointer', { x: scaled.x, y: scaled.y, text: 'Clicking here…' })
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
    log('done', 'execute complete')
    execTimer.total()
    return { done: true, reached_bottom: reachedBottom }
  })

  ipcMain.handle('hide-highlights', () => {
    highlightWindow?.hide()
    highlightWindow?.webContents.send('clear-highlights')
  })

  ipcMain.handle('config-get', () => loadConfig())
  ipcMain.handle('config-save', async (_e, patch: Partial<AppConfig>) => {
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
    if (patch.wakeWord) {
      const wasOn = prev.wakeWord.enabled
      const nowOn = next.wakeWord.enabled
      const phraseChanged = prev.wakeWord.phrase !== next.wakeWord.phrase
      try {
        if (!nowOn && wasOn) {
          await agent?.disableWakeWord()
        } else if (nowOn && (!wasOn || phraseChanged)) {
          if (!modelInstalled()) {
            // Kick off auto-install; agent will be enabled when install completes.
            installModel().then(() => agent?.enableWakeWord(next.wakeWord.phrase))
              .catch(e => console.error('[wake] model install failed:', (e as Error).message))
          } else {
            await agent?.enableWakeWord(next.wakeWord.phrase)
          }
        }
      } catch (e) {
        console.error('[wake] toggle failed:', (e as Error).message)
      }
    }
    return next
  })

  ipcMain.handle('wake-model-status', () => ({
    installed: modelInstalled(),
    path: modelRoot(),
  }))
  ipcMain.handle('wake-model-install', async () => {
    try {
      await installModel()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.on('settings-open', () => createSettingsWindow())

  ipcMain.handle('transcribe', async (_event, audio: ArrayBuffer) => {
    if (!process.env.OPENAI_API_KEY) throw new Error('Whisper requires OPENAI_API_KEY')

    // Skip Whisper on tiny recordings — model hallucinates on < ~0.5s of audio
    if (audio.byteLength < 6000) {
      console.log('[transcribe] audio too short (', audio.byteLength, 'bytes), skipping')
      return ''
    }

    const tmpPath = join(app.getPath('temp'), 'ai-overlay-recording.webm')
    console.log('[transcribe] writing', audio.byteLength, 'bytes to', tmpPath)
    writeFileSync(tmpPath, Buffer.from(audio))

    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 })
      const result = await client.audio.transcriptions.create({
        file: createReadStream(tmpPath),
        model: 'whisper-1',
        language: 'en',
        prompt: 'AI assistant voice command. User speaks English. Common words: open, click, email, Gmail, drafts, inbox, reply, compose, send, navigate.'
      })
      console.log('[transcribe] result:', result.text)
      const estSecs = audio.byteLength / 6000
      const whisperCost = (estSecs / 60) * 0.006
      console.log(`[tokens] whisper | ~${estSecs.toFixed(1)}s audio | $${whisperCost.toFixed(5)}`)
      return result.text
    } finally {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function scaleActionForAgent(action: Action, scale: number): Action {
  if (action.type === 'scroll') {
    // Cap AI-chosen scroll amounts to prevent full-page jumps that overshoot target content.
    const cappedAmount = action.amount != null ? Math.min(Math.max(1, action.amount), 2) : 1
    const base = { ...action, amount: cappedAmount }
    if (base.x != null && base.y != null) {
      return { ...base, x: Math.round(base.x * scale), y: Math.round(base.y * scale) } as Action
    }
    return base as Action
  }
  if (action.type === 'click_bbox' && action.bbox) {
    const [x1, y1, x2, y2] = action.bbox
    const cx = Math.round(((x1 + x2) / 2) * scale)
    const cy = Math.round(((y1 + y2) / 2) * scale)
    return { type: 'click', x: cx, y: cy, button: action.button ?? 'left' }
  }
  if ((action.type === 'click' || action.type === 'move') && action.x != null && action.y != null) {
    return { ...action, x: Math.round(action.x * scale), y: Math.round(action.y * scale) }
  }
  if (action.type === 'click_element' && action.bbox) {
    const [x1, y1, x2, y2] = action.bbox
    return {
      ...action,
      bbox: [Math.round(x1 * scale), Math.round(y1 * scale), Math.round(x2 * scale), Math.round(y2 * scale)]
    } as Action
  }
  return action
}

export type Action =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { type: 'click_bbox'; bbox: [number, number, number, number]; button?: 'left' | 'right'; description?: string }
  | { type: 'click_element'; text: string; button?: 'left' | 'right'; bbox?: [number, number, number, number] }
  | { type: 'click_nth_element'; text: string; n: number; button?: 'left' | 'right' }
  | { type: 'type'; text: string }
  | { type: 'hotkey'; keys: string[] }
  | { type: 'open_url'; url: string }
  | { type: 'navigate_url'; url: string }
  | { type: 'focus_browser' }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; x?: number; y?: number }
