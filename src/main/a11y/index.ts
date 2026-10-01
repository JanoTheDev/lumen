// Wires 06's local voice commands into the app: the real A11yIo (agent commands, coords,
// config, windows, announce) and the router's local grammar hook. index.ts calls installA11y().
import { screen, shell } from 'electron'
import type { Point, Rect } from '@shared/types'
import { bus } from '../bus'
import { loadConfig, saveConfig } from '../config'
import { log } from '../logger'
import { appUrl } from '../ai/app-context'
import { logicalToPhys, physRectToLogical } from '../actions/coords'
import { assertSafeUrl, isSafeUrl } from '../actions/safety'
import * as commands from '../agent/commands'
import { getAgent, requireAgent } from '../agent/instance'
import { applyListenerState } from '../agent/sync'
import { guideState } from '../guides/session'
import { broadcastConfig } from '../ipc/settings'
import { currentContext } from '../query/context'
import { setLocalGrammar } from '../query/router'
import { flattenElements } from '../query/uia-list'
import { speakAnswer } from '../speech/tts'
import * as screenLayer from '../windows/screen-layer'
import * as settingsWin from '../windows/settings'
import { setStatus } from '../windows/status'
import { Announcer, type AnnounceOptions } from './announce'
import { screenReaderActive } from './at-state'
import { A11yCommands, type A11yIo, type A11yScene } from './dispatch'

const SNAPSHOT_TIMEOUT_MS = 2500
const OCR_TIMEOUT_MS = 4000
const ACT_TIMEOUT_MS = 3000
const INPUT_TIMEOUT_MS = 15_000

let announcer: Announcer | null = null
let a11y: A11yCommands | null = null

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
      await commands.announce(agent, text, priority, { timeoutMs: 2000 })
      return true
    },
    speak: (text) => void speakAnswer(text).catch(() => {}),
    publish: (text, priority) => bus.emit({ type: 'a11y.announce', text, priority })
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

function setDwellPaused(paused: boolean): boolean {
  const agent = getAgent()
  const cfg = loadConfig()
  if (!agent || !cfg.dwellClick.enabled) return false
  if (agent.protocol === 2 && agent.hasCapability('dwell')) {
    agent.request(paused ? 'dwell_pause' : 'dwell_resume').catch(() => {})
  } else if (paused) {
    agent.disableDwell().catch(() => {})
  } else {
    agent.enableDwell(cfg.dwellClick.dwellMs, cfg.dwellClick.cooldownMs).catch(() => {})
  }
  return true
}

function saveAndBroadcast(patch: Parameters<typeof saveConfig>[0]): void {
  const next = saveConfig(patch)
  broadcastConfig(next)
}

export function createIo(): A11yIo {
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
      // v1 has no screen layer of its own; create it for the numbers and the grid.
      screenLayer.create()
      screenLayer.setScene(part)
    },
    feedback: (text, ok) => {
      setStatus(ok ? 'answer' : 'error', text, undefined, loadConfig().a11y.timings.statusHoldMs)
      announce(text, { kind: ok ? 'command' : 'error' })
    },
    openUrl: (url) => {
      if (!isSafeUrl(url)) return false
      shell.openExternal(assertSafeUrl(url)).catch(() => {})
      return true
    },
    appUrl,
    openSettings: () => settingsWin.create(),
    setDwellPaused,
    setScanning: () => false,
    setWakeWord: (on) => {
      const cfg = loadConfig()
      saveAndBroadcast({ wakeWord: { ...cfg.wakeWord, enabled: on } })
      applyListenerState(loadConfig())
    },
    setKeepMarks: (on) => {
      const cfg = loadConfig()
      saveAndBroadcast({ a11y: { ...cfg.a11y, marks: { ...cfg.a11y.marks, keep: on } } })
    },
    keepMarks: () => loadConfig().a11y.marks.keep,
    guideActive: () => guideState().guideActive,
    log: (msg) => log('plan', msg)
  }
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
  bus.on('voice.cancelled', () => commandsImpl.reset())
}
