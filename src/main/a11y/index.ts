// Wires 06's local voice commands into the app: the real A11yIo (agent commands, coords,
// config, windows, announce) and the router's local grammar hook. index.ts calls installA11y().
import { screen, shell } from 'electron'
import type { Point, Rect } from '@shared/types'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'
import { appUrl } from '../ai/app-context'
import { describeScreen, explainTarget } from '../ai/describe'
import { currentFrame, logicalToPhys, physRectToLogical, physToImage } from '../actions/coords'
import { assertSafeUrl, isSafeUrl } from '../actions/safety'
import * as commands from '../agent/commands'
import { getAgent, requireAgent } from '../agent/instance'
import { guideState } from '../guides/session'
import { registerA11yIpc } from '../ipc/a11y'
import { broadcastConfig, patchConfig } from '../ipc/settings'
import { onBroadcast } from '../windows/registry'
import { currentContext } from '../query/context'
import { setLocalGrammar } from '../query/router'
import { flattenElements } from '../query/uia-list'
import { speakAnswer, stopSpeaking } from '../speech/tts'
import * as assistant from '../windows/assistant'
import * as commandSheet from '../windows/command-sheet'
import * as screenLayer from '../windows/screen-layer'
import * as settingsWin from '../windows/settings'
import { Announcer, type AnnounceOptions } from './announce'
import { atState, screenReaderActive } from './at-state'
import { installCoexist } from './coexist-install'
import { voiceControlName } from './coexist'
import { focusEventsWanted, pushFocusSubscription, wantFocusEvents } from './focus-events'
import { FocusNarrator } from './focus-narration'
import { A11yCommands, type A11yIo, type A11yScene, type TextScope, type UiaText } from './dispatch'
import { phrase } from './phrases'
import { dwellController } from './dwell'
import { commandSheetData, helpShortcut, installHelpShortcut } from './help'
import { installDwell } from './install-dwell'
import { installShortcuts } from './install-shortcuts'
import { installSwitch, type SwitchControl } from './install-switch'
import { installSystemEvents, refreshAtState } from './system-events'
import { onTextScaleChange } from './text-scale'

const SNAPSHOT_TIMEOUT_MS = 2500
const OCR_TIMEOUT_MS = 4000
const ACT_TIMEOUT_MS = 3000
const INPUT_TIMEOUT_MS = 15_000
const TEXT_TIMEOUT_MS = 4000
/** Page text asked of the agent (about an hour of listening). */
const PAGE_MAX_CHARS = 60_000
/** OCR box around the pointer for "read this", physical px. */
const OCR_BOX = { w: 640, h: 180 }

let announcer: Announcer | null = null
let a11y: A11yCommands | null = null
let narrator: FocusNarrator | null = null
let switchCtl: SwitchControl | null = null

/** One short message to the user through the announce policy (screen reader, TTS or visual). */
export function announce(text: string, opts?: AnnounceOptions): void {
  announcer?.announce(text, opts)
}

/** The command dispatcher (null before installA11y). */
export function voiceCommands(): A11yCommands | null {
  return a11y
}

function createAnnouncer(): Announcer {
  return new Announcer({
    now: () => Date.now(),
    enabled: () => loadConfig().a11y.announce !== 'off',
    screenReaderActive,
    ttsOn: () => loadConfig().voice.tts !== 'off',
    sendToScreenReader: async (text, priority) => {
      const agent = getAgent()
      if (!agent?.hasCapability('announce')) return false
      const r = await commands.announce(agent, text, priority, { timeoutMs: 2000 })
      return r.spoken
    },
    speak: (text) => void speakAnswer(text).catch(() => {}),
    publish: (text, priority, via, kind) =>
      bus.emit({ type: 'a11y.announce', text, priority, via, kind }),
    unspoken: (text, priority, kind) =>
      bus.emit({ type: 'a11y.announce', text, priority, via: 'none', kind })
  })
}

function logicalRectToPhys(r: Rect): Rect {
  const tl = logicalToPhys({ x: r.x, y: r.y })
  const br = logicalToPhys({ x: r.x + r.w, y: r.y + r.h })
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const r = Math.max(...rects.map((q) => q.x + q.w))
  const b = Math.max(...rects.map((q) => q.y + q.h))
  return { x, y, w: r - x, h: b - y }
}

function displaysPhys(): Rect[] {
  return screen
    .getAllDisplays()
    .map((d) =>
      logicalRectToPhys({ x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height })
    )
}

/** "Pause dwell" / "resume dwell": a user pause in the dwell controller (corner and palette stay live). */
function setDwellPaused(paused: boolean): boolean {
  return dwellController()?.setPaused(paused) ?? false
}

/** Status text plus an announcement for a command's result. */
function feedback(text: string, ok: boolean): void {
  assistant.setStatus(
    ok ? 'answer' : 'error',
    text,
    undefined,
    loadConfig().a11y.timings.statusHoldMs
  )
  announce(text, { kind: ok ? 'command' : 'error' })
}

/** Voices `text` through the screen reader, else Lumen's voice; false when neither can. */
function voice(text: string): boolean {
  const agent = getAgent()
  if (screenReaderActive() && agent?.hasCapability('announce')) {
    commands.announce(agent, text, 'polite', { timeoutMs: 2000 }).catch(() => {})
    return true
  }
  if (loadConfig().voice.tts === 'off') return false
  speakAnswer(text).catch(() => {})
  return true
}

async function readText(scope: TextScope): Promise<UiaText | null> {
  const agent = getAgent()
  if (!agent?.hasCapability('uia-text')) return null
  const args: Record<string, unknown> = {
    scope,
    maxChars: scope === 'document' ? PAGE_MAX_CHARS : 20_000
  }
  if (scope === 'point') Object.assign(args, logicalToPhys(screen.getCursorScreenPoint()))
  try {
    return await agent.request<UiaText>('uia_text', args, { timeoutMs: TEXT_TIMEOUT_MS })
  } catch (e) {
    log('fail', `uia_text ${scope} failed (${(e as Error).message})`)
    return null
  }
}

async function ocrText(where: 'cursor' | 'window'): Promise<string> {
  const agent = getAgent()
  if (!agent) return ''
  let region: Rect
  if (where === 'cursor') {
    const c = logicalToPhys(screen.getCursorScreenPoint())
    region = { x: c.x - OCR_BOX.w / 2, y: c.y - OCR_BOX.h / 2, ...OCR_BOX }
  } else {
    const w = await commands.activeWindow(agent, { timeoutMs: 1000 }).catch(() => null)
    if (!w || w.rect.w <= 0 || w.rect.h <= 0) return ''
    region = w.rect
  }
  const r = await commands.ocr(agent, { region }, { timeoutMs: OCR_TIMEOUT_MS }).catch(() => null)
  return r ? r.lines.map((l) => l.text).join('\n') : ''
}

/** "What's under my cursor": 05 explainTarget at the pointer, UIA name/role when off-frame. */
async function explainCursor(): Promise<string> {
  const phys = logicalToPhys(screen.getCursorScreenPoint())
  const g = currentFrame()
  const onFrame =
    phys.x >= g.originX &&
    phys.y >= g.originY &&
    phys.x < g.originX + g.width &&
    phys.y < g.originY + g.height
  if (onFrame) {
    const p = physToImage(g, phys)
    const r = await explainTarget({
      kind: 'point',
      x: Math.round(p.x),
      y: Math.round(p.y),
      frame: '1'
    })
    return r.spoken
  }
  const at = await readText('point')
  if (at?.name) return `${at.name}, ${at.role ?? 'control'}.`
  return "I can't tell what is there."
}

function createIo(): A11yIo {
  return {
    now: () => Date.now(),
    input: async (steps) => {
      await commands.input(requireAgent(), steps, { timeoutMs: INPUT_TIMEOUT_MS })
    },
    uiaAct: async (elementId, action) => {
      const r = await commands.uiaAct(
        requireAgent(),
        { elementId, action },
        { timeoutMs: ACT_TIMEOUT_MS }
      )
      return !!r.done
    },
    snapshot: async (scope) => {
      const snap = await commands
        .uiaSnapshot(
          requireAgent(),
          { scope: 'foreground', maxNodes: 400, interactiveOnly: true },
          { timeoutMs: SNAPSHOT_TIMEOUT_MS }
        )
        .catch((e: Error) => {
          log('fail', `show numbers: uia snapshot failed (${e.message})`)
          return null
        })
      const nodes = snap ? flattenElements(snap.root).map((f) => f.node) : []
      let area = snap?.root.rect
      if (scope === 'all' || !area || area.w <= 0 || area.h <= 0) area = union(displaysPhys())
      return { snapshotId: snap?.snapshotId, nodes, area }
    },
    ocrLines: async (area) => {
      const r = await commands.ocr(requireAgent(), { region: area }, { timeoutMs: OCR_TIMEOUT_MS })
      return r.lines
    },
    recentMarks: () => {
      const ctx = currentContext()
      // Only a "none" quality table numbers every control; "partial" skips named ones.
      if (!ctx?.marks || ctx.uiaQuality !== 'none') return null
      return { table: ctx.marks, at: ctx.at }
    },
    cachedNodes: () => {
      const ctx = currentContext()
      return ctx?.uia ? flattenElements(ctx.uia.root).map((f) => f.node) : []
    },
    foregroundTitle: async () => {
      const agent = getAgent()
      if (!agent) return ''
      const w = await commands.activeWindow(agent, { timeoutMs: 1000 }).catch(() => null)
      return w?.title ?? ''
    },
    cursorLogical: (): Point => screen.getCursorScreenPoint(),
    logicalToPhys,
    physRectToLogical,
    monitors: () =>
      screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }
      })),
    setScene: (part: A11yScene) => {
      screenLayer.create()
      screenLayer.setScene(part)
    },
    feedback,
    openUrl: (url) => {
      if (!isSafeUrl(url)) return false
      shell.openExternal(assertSafeUrl(url)).catch(() => {})
      return true
    },
    appUrl,
    openSettings: () => settingsWin.create(),
    openHelp: () => {
      commandSheet.show()
      return true
    },
    setDwellPaused,
    setScanning: (on) => switchCtl?.setScanning(on) ?? false,
    // Through the settings path, so the listener, tray and other config watchers follow.
    setWakeWord: (on) => {
      void patchConfig({ wakeWord: { ...loadConfig().wakeWord, enabled: on } })
    },
    setKeepMarks: (on) => {
      const cfg = loadConfig()
      void patchConfig({ a11y: { ...cfg.a11y, marks: { ...cfg.a11y.marks, keep: on } } })
    },
    keepMarks: () => loadConfig().a11y.marks.keep,
    guideActive: () => guideState().guideActive,
    answerShown: () => assistant.answerShown(),
    answer: (op) => {
      if (op === 'pin') return assistant.pinAnswer(true)
      if (op === 'longer') return assistant.extendTimers()
      assistant.close()
      return true
    },
    log: (msg) => log('plan', msg),
    describe: async (detail) => (await describeScreen({ detail, focus: 'window' })).spoken,
    explainCursor,
    readText,
    ocrText,
    say: (text) => {
      assistant.showAnswer(text)
      voice(text)
    },
    speakPart: (text, index, total) => {
      assistant.showAnswer(text)
      // An 'answer' status line is shown, not announced: the part itself is what is heard.
      const simple = loadConfig().a11y.simpleMode
      assistant.status(
        'answer',
        index === 0
          ? `${phrase('reading', simple)} (1 of ${total})`
          : `Part ${index + 1} of ${total}`
      )
      stopSpeaking()
      voice(text)
    },
    silence: () => stopSpeaking(),
    canSpeak: () =>
      (screenReaderActive() && !!getAgent()?.hasCapability('announce')) ||
      loadConfig().voice.tts !== 'off',
    speechRate: () => (screenReaderActive() ? 1 : loadConfig().voice.ttsRate),
    readingChanged: (state) => {
      if (state === 'idle') assistant.settle()
    },
    simpleMode: () => loadConfig().a11y.simpleMode,
    voiceControl: () => voiceControlName(atState(), loadConfig())
  }
}

function installFocusNarration(): void {
  narrator = new FocusNarrator({
    enabled: () => loadConfig().a11y.focusNarration,
    screenReaderActive,
    announce: (text) => announce(text, { kind: 'focus' }),
    subscribe: (on) => wantFocusEvents('narration', on),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  })
  onBroadcast('settings:changed', () => narrator?.sync())
  const agent = getAgent()
  agent?.onEvent('focus-changed', (data) => narrator?.onFocusChanged(data))
  if (agent) installSystemEvents(agent, () => narrator?.sync())
  agent?.onEvent('agent-ready', () => {
    // init carries focus-changed and a11y-state already; re-assert focus (in case init failed)
    // and read the screen reader once in case the first a11y-state event was missed.
    if (focusEventsWanted()) pushFocusSubscription()
    void refreshAtState(agent).then((changed) => changed && narrator?.sync())
  })
  narrator.sync()
}

/** Installs the local grammar ahead of the LLM router and the announcer. Call once. */
export function installA11y(): void {
  if (a11y) return
  announcer = createAnnouncer()
  const commandsImpl = new A11yCommands(createIo())
  a11y = commandsImpl
  setLocalGrammar((utterance) =>
    loadConfig().a11y.voiceCommands ? commandsImpl.tryHandle(utterance) : null
  )
  // Escape / voice cancel also takes numbers and the grid away and stops auto-scroll.
  bus.on('voice.cancelled', () => {
    commandsImpl.reset()
    dwellController()?.reset()
  })
  // Talking to Lumen pauses a reading ("continue" goes on); a new request ends it.
  bus.on('voice.started', () => commandsImpl.reader.pause())
  bus.on('query.started', () => commandsImpl.reader.stop())
  installCoexist({ announce: (text) => feedback(text, true) })
  installFocusNarration()
  const dwell = installDwell({
    announce: (text) => announce(text, { kind: 'command' }),
    wantFocusEvents
  })
  installHelpShortcut()
  // Windows text size changed: re-send the config (renderer font size) and re-zoom windows.
  onTextScaleChange(() => broadcastConfig(loadConfig()))
  const sw = installSwitch({
    commands: () => a11y,
    announce: (text) => announce(text, { kind: 'scan' }),
    feedback
  })
  switchCtl = sw
  const shortcuts = installShortcuts({
    commands: () => a11y,
    toggleKeyboard: () => sw.toggleKeyboard(),
    feedback
  })

  registerA11yIpc({
    commands: () => commandSheetData(commandsImpl.context(), helpShortcut()),
    closeSheet: () => commandSheet.hide(),
    dwellState: () => dwell.state(),
    dwellPick: (pick) => dwell.choose(pick),
    keyboardState: () => sw.keyboardState(),
    keyboardKey: (id) => sw.keyboardKey(id),
    toggleKeyboard: () => sw.toggleKeyboard(),
    shortcuts: () => shortcuts.status()
  })
}
