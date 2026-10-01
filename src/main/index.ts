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
import { shutdownConnectors } from './connectors'
import { log } from './logger'
import { AgentBridge } from './agent/bridge'
import { getAgent, setAgent } from './agent/instance'
import { startAgent, wireAgentEvents } from './agent/events'
import { holdEscape, releaseEscape, resetEscape, setEscapeHandler } from './agent/escape'
import {
  agentInitArgs,
  applyDictationHotkey,
  applyDwellState,
  applyListenerState,
  setHotkey
} from './agent/sync'
import { assertSafeUrl, isSafeUrl } from './actions/safety'
import { replaySavedGuide, saveLastAsGuide, startGuide } from './guides/session'
import { cancelAll } from './query/cancel'
import { interceptLocal } from './query/local'
import { installHelpers, interceptHelpers } from './coach'
import { registerHelpersIpc } from './coach/ipc'
import { installDeictic, interceptDeictic } from './deictic'
import { installLabels, interceptLabels } from './labels'
import { registerLabelsIpc } from './labels/ipc'
import { registerFirstsIpc } from './teach/firsts-ipc'
import { installAgentMode, interceptAgentMode, registerAgentModeIpc } from './agent-mode'
import { installClaudeCode, interceptClaudeCode, shutdownClaudeCode } from './claude-code'
import { runQuery } from './query/pipeline'
import { setAnswerAnnouncer, speakAnswer, warmTts } from './speech/tts'
import { prepareStt, transcribe } from './speech/stt'
import { dictate, maybeAutoDictate, offerRecovery } from './speech/dictation/pipeline'
import { isOwnRendererUrl } from './windows/factory'
import { applyUiScaleOnLoad } from './windows/registry'
import * as tray from './windows/tray'
import * as assistantWin from './windows/assistant'
import * as screenLayer from './windows/screen-layer'
import * as homeWin from './windows/home'
import * as settingsWin from './windows/settings'
import { registerAnswerIpc } from './ipc/answer'
import { registerGuidesIpc } from './ipc/guides'
import { registerTeachIpc } from './ipc/teach'
import { registerSkillsIpc } from './ipc/skills'
import { registerBridgesIpc } from './ipc/bridges'
import { registerConnectorsIpc } from './ipc/connectors'
import { registerHudIpc } from './ipc/hud'
import { registerQueryIpc } from './ipc/query'
import { registerSettingsIpc } from './ipc/settings'
import { registerVoiceIpc } from './ipc/voice'
import { registerWakeIpc } from './ipc/wake'
import { registerMemoryIpc } from './ipc/memory'
import { registerUsageIpc } from './ipc/usage'
import { registerAgentIpc } from './ipc/agent'
import { registerClaudeCodeIpc } from './ipc/claude-code'
import { flushOnQuit, startMemory } from './ai/memory/runtime'
import { registerUiIpc } from './ipc/ui'
import { announce, installA11y } from './a11y'
import { installFace } from './face'
import { installLiveFeedback } from './a11y/live-feedback'
import { installTeach } from './teach'
import { installRoutines, interceptRoutines, registerRoutinesIpc } from './routines'
import { installUserActivityPause } from './agent-mode/input-lane'
import { installSkills } from './skills'
import { installLessonOutput } from './windows/lesson'
import { loadVault } from './keys/vault'
import { registerKeysIpc } from './keys/ipc'
import { installLogFile } from './diagnostics/log-file'
import { installCrashHandlers, startCrashReporter } from './diagnostics/crash'
import { registerDiagnosticsIpc } from './diagnostics/ipc'
import { registerFilesIpc } from './files/ipc'
import { registerFirstRunIpc } from './first-run/ipc'
import { applyAutostart, startedHidden } from './first-run/autostart'
import { onConfigPatched } from './ipc/settings'
import { installUpdates } from './update'

// Installed builds have no console: keep a log file, local crash dumps, and survive stray errors.
installLogFile(app.getPath('logs'))
startCrashReporter()
installCrashHandlers()

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
  assistantWin.create()
  screenLayer.create()
  homeWin.create()
  tray.create()
  applyUiScaleOnLoad()
  // First run, or setup never finished: open the setup flow.
  if (!loadConfig().onboarding.done && !startedHidden()) settingsWin.create('onboarding')
}

function registerIpc(): void {
  registerHudIpc({ armEscape: () => holdEscape('hud'), disarmEscape: () => releaseEscape('hud') })
  registerAnswerIpc()
  registerWakeIpc()
  registerVoiceIpc({ speak: speakAnswer, transcribe, dictate })
  registerGuidesIpc({ saveLast: saveLastAsGuide, replay: replaySavedGuide })
  registerTeachIpc()
  registerSkillsIpc()
  registerHelpersIpc()
  registerLabelsIpc()
  registerFirstsIpc()
  registerBridgesIpc()
  registerConnectorsIpc()
  registerMemoryIpc()
  registerUsageIpc()
  registerAgentIpc()
  registerAgentModeIpc()
  registerRoutinesIpc()
  registerClaudeCodeIpc()
  registerKeysIpc()
  registerFirstRunIpc()
  registerDiagnosticsIpc()
  registerFilesIpc()
  registerSettingsIpc({ setHotkey, applyDictationHotkey, applyListenerState, applyDwellState })
  registerUiIpc({
    cancel: () => {
      cancelAll()
      bus.emit({ type: 'voice.cancelled' })
    }
  })
  registerQueryIpc({
    intercept: (prompt) =>
      interceptClaudeCode(prompt) ??
      interceptAgentMode(prompt) ??
      interceptRoutines(prompt) ??
      interceptHelpers(prompt) ??
      interceptDeictic(prompt) ??
      interceptLabels(prompt) ??
      interceptLocal(prompt),
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
  // Dictation left over from a crash: taken now, before any new dictation, and shown once the
  // answer card can show it.
  offerRecovery(2500)
  createWindows()
  applyAutostart(loadConfig().system.startAtLogin)
  onConfigPatched((next) => applyAutostart(next.system.startAtLogin))
  installUpdates()

  const configWarning = lastConfigWarning()
  if (configWarning) assistantWin.setStatus('error', configWarning, undefined, 8000)

  // Escape cancels in-flight work in main directly and tells the HUD to stop recording.
  setEscapeHandler(() => {
    cancelAll()
    bus.emit({ type: 'voice.cancelled' })
  })

  // The wake spotter runs in main and the dwell ring/palette are windows: apply them now
  // instead of waiting for the agent (no agent is set yet, so nothing is sent to it).
  applyListenerState(loadConfig())
  applyDwellState(loadConfig())

  // Hotkeys, dwell and event subscriptions go out as `init` after every agent (re)start.
  const agent = new AgentBridge({ initArgs: () => agentInitArgs(loadConfig()) })
  setAgent(agent)
  wireAgentEvents(agent)
  // Not awaited: IPC handlers below must be registered before the windows finish loading.
  startAgent(agent)
  installAgentMode()
  installRoutines()
  installUserActivityPause()
  void installClaudeCode()
  registerIpc()
  installA11y()
  installLessonOutput()
  installTeach()
  installHelpers()
  installDeictic()
  installLabels()
  installFace()
  installSkills()
  setAnswerAnnouncer((text) => announce(text, { kind: 'answer' }))
  installLiveFeedback(announce)
  warmTts()
  prepareStt()
  // A conversation left open when the app last closed is summarized now (memory on only).
  startMemory()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) assistantWin.create()
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
  shutdownClaudeCode()
  void shutdownConnectors()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
