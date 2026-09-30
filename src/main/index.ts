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
import { applyAgentState, applyDwellState, applyListenerState, setHotkey } from './agent/sync'
import { assertSafeUrl, isSafeUrl } from './actions/safety'
import { interceptGuideCommand, replaySavedGuide, saveLastAsGuide, startGuide } from './guides/session'
import { cancelAll } from './query/cancel'
import { runQuery } from './query/pipeline'
import { speakAnswer } from './speech/tts'
import { transcribe } from './speech/stt'
import { isOwnRendererUrl } from './windows/factory'
import { applyUiScaleOnLoad } from './windows/registry'
import { setStatus } from './windows/status'
import * as hud from './windows/hud'
import * as statusWin from './windows/status'
import * as answer from './windows/answer'
import * as highlight from './windows/highlight'
import * as dwellRing from './windows/dwell-ring'
import * as tray from './windows/tray'
import { registerAnswerIpc } from './ipc/answer'
import { registerGuidesIpc } from './ipc/guides'
import { registerHighlightIpc } from './ipc/highlight'
import { registerHudIpc } from './ipc/hud'
import { registerQueryIpc } from './ipc/query'
import { registerSettingsIpc } from './ipc/settings'
import { registerVoiceIpc } from './ipc/voice'
import { registerWakeIpc } from './ipc/wake'

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
  hud.create()
  highlight.create()
  answer.create()
  statusWin.create()
  dwellRing.create()
  tray.create()
  applyUiScaleOnLoad(loadConfig().a11y.uiScale)
}

function registerIpc(): void {
  registerHudIpc({ armEscape: () => holdEscape('hud'), disarmEscape: () => releaseEscape('hud') })
  registerAnswerIpc()
  registerHighlightIpc()
  registerWakeIpc()
  registerVoiceIpc({ speak: speakAnswer, transcribe })
  registerGuidesIpc({ saveLast: saveLastAsGuide, replay: replaySavedGuide })
  registerSettingsIpc({ setHotkey, applyListenerState, applyDwellState })
  registerQueryIpc({
    intercept: interceptGuideCommand,
    runQuery: (prompt, opts, scope) => runQuery(prompt, opts, scope, { speak: speakAnswer, onGuide: startGuide }),
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  hardenWebContents()
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) hud.create()
  })
})

app.on('will-quit', () => {
  resetEscape()
  getAgent()?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
