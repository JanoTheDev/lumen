import { APP_ID } from './app-id'
import { config } from 'dotenv'
import { join } from 'path'
// Keys are read at runtime, never baked into the bundle. Dev: repo .env. Installed: userData/.env.
config({ path: join(process.cwd(), '.env'), quiet: true })
try {
  config({ path: join(app.getPath('userData'), '.env'), quiet: true })
} catch {
  /* userData unavailable this early on some setups; repo .env still applies */
}

import { app, shell, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { bus } from './bus'
import { loadConfig, lastConfigWarning } from './config'
import { log } from './logger'
import { AgentBridge } from './agent/bridge'
import { getAgent, setAgent } from './agent/instance'
import { startAgent, wireAgentEvents } from './agent/events'
import { holdEscape, releaseEscape, resetEscape, setEscapeHandler } from './agent/escape'
import {
  applyAgentState,
  applyDictationHotkey,
  applyDwellState,
  applyListenerState,
  setHotkey
} from './agent/sync'
import { assertSafeUrl, isSafeUrl } from './actions/safety'
import { replaySavedGuide, saveLastAsGuide, startGuide } from './guides/session'
import { cancelAll } from './query/cancel'
import { interceptLocal } from './query/local'
import { runQuery } from './query/pipeline'
import { setAnswerAnnouncer, speakAnswer, warmTts } from './speech/tts'
import { prepareStt, transcribe } from './speech/stt'
import { dictate, maybeAutoDictate, offerRecovery } from './speech/dictation/pipeline'
import { isOwnRendererUrl } from './windows/factory'
import { applyUiScaleOnLoad } from './windows/registry'
import { setStatus } from './windows/status'
import * as hud from './windows/hud'
import * as statusWin from './windows/status'
import * as answer from './windows/answer'
import * as highlight from './windows/highlight'
import * as dwellRing from './windows/dwell-ring'
import * as tray from './windows/tray'
import * as assistantWin from './windows/assistant'
import * as screenLayer from './windows/screen-layer'
import * as homeWin from './windows/home'
import * as settingsWin from './windows/settings'
import { uiV2 } from './windows/ui-mode'
import { registerAnswerIpc } from './ipc/answer'
import { registerGuidesIpc } from './ipc/guides'
import { registerTeachIpc } from './ipc/teach'
import { registerHighlightIpc } from './ipc/highlight'
import { registerHudIpc } from './ipc/hud'
import { registerQueryIpc } from './ipc/query'
import { registerSettingsIpc } from './ipc/settings'
import { registerVoiceIpc } from './ipc/voice'
import { registerWakeIpc } from './ipc/wake'
import { registerMemoryIpc } from './ipc/memory'
import { registerUsageIpc } from './ipc/usage'
import { registerAgentIpc } from './ipc/agent'
import { flushOnQuit, startMemory } from './ai/memory/runtime'
import { registerUiIpc } from './ipc/ui'
import { announce, installA11y } from './a11y'
import { installTeach } from './teach'
import { installLessonOutput } from './windows/lesson'
import { loadVault } from './keys/vault'
import { registerKeysIpc } from './keys/ipc'

// No Lumen window may open popups or navigate away from its own renderer.
function hardenWebContents(): void {
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
}

function createWindows(): void {
  if (uiV2()) {
    assistantWin.create()
    screenLayer.create()
  } else {
    hud.create()
    highlight.create()
    answer.create()
    statusWin.create()
    dwellRing.create()
  }
  homeWin.create()
  tray.create()
  applyUiScaleOnLoad(loadConfig().a11y.uiScale)
  // First run, or setup never finished: open the setup flow.
  if (!loadConfig().onboarding.done) settingsWin.create('onboarding')
}

function registerIpc(): void {
  registerHudIpc({ armEscape: () => holdEscape('hud'), disarmEscape: () => releaseEscape('hud') })
  registerAnswerIpc()
  registerHighlightIpc()
  registerWakeIpc()
  registerVoiceIpc({ speak: speakAnswer, transcribe, dictate })
  registerGuidesIpc({ saveLast: saveLastAsGuide, replay: replaySavedGuide })
  registerTeachIpc()
  registerMemoryIpc()
  registerUsageIpc()
  registerAgentIpc()
  registerKeysIpc()
  registerSettingsIpc({ setHotkey, applyDictationHotkey, applyListenerState, applyDwellState })
  registerUiIpc({
    cancel: () => {
      cancelAll()
      bus.emit({ type: 'voice.cancelled' })
    }
  })
  registerQueryIpc({
    intercept: interceptLocal,
    preempt: (prompt, opts, scope) =>
      opts.lowDetail ? Promise.resolve(false) : maybeAutoDictate(prompt, scope.signal),
    runQuery: (prompt, opts, scope) =>
      runQuery(prompt, opts, scope, { speak: speakAnswer, onGuide: startGuide })
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  hardenWebContents()
  // Pasted keys (DPAPI vault) fill in for anything .env did not set.
  loadVault()
  createWindows()

  const configWarning = lastConfigWarning()
  if (configWarning) setStatus('error', configWarning, undefined, 8000)

  // Escape cancels in-flight work in main directly and tells the HUD to stop recording.
  setEscapeHandler(() => {
    cancelAll()
    bus.emit({ type: 'voice.cancelled' })
  })

  // Hotkey, listener and dwell state are re-sent after every agent (re)start.
  const agent = new AgentBridge({ initState: () => applyAgentState(loadConfig()) })
  setAgent(agent)
  wireAgentEvents(agent)
  // Not awaited: IPC handlers below must be registered before the windows finish loading.
  startAgent(agent)
  registerIpc()
  installA11y()
  installLessonOutput()
  installTeach()
  setAnswerAnnouncer((text) => announce(text, { kind: 'answer' }))
  warmTts()
  prepareStt()
  // A conversation left open when the app last closed is summarized now (memory on only).
  startMemory()
  // Dictation left over from a crash is offered once the answer card can show it.
  setTimeout(offerRecovery, 2500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) hud.create()
  })
})

// The open conversation is summarized before quitting (bounded wait; nothing when memory is off).
let memoryFlushed = false
app.on('before-quit', (event) => {
  if (memoryFlushed) return
  event.preventDefault()
  memoryFlushed = true
  flushOnQuit().finally(() => app.quit())
})

app.on('will-quit', () => {
  resetEscape()
  getAgent()?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
