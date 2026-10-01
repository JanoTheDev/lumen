// Fake A11yIo for the local voice command dispatcher (src/main/a11y/dispatch.ts). Records
// every agent call, scene and feedback; physical px = logical px × scale.
import type { ElementNode, InputStep, Point, Rect, UiaAction } from '../../src/shared/types'
import type { OcrWord } from '../../src/main/agent/commands'
import type { A11yIo, A11yScene, MonitorBounds } from '../../src/main/a11y/dispatch'
import type { MarksTable } from '../../src/main/a11y/marks'

export interface FakeA11yOptions {
  nodes?: ElementNode[]
  /** Physical rect of the foreground window. */
  area?: Rect
  ocr?: OcrWord[]
  scale?: number
  monitors?: MonitorBounds[]
  cursor?: Point
  title?: string
  guide?: boolean
  keep?: boolean
  dwell?: boolean
  recent?: { table: MarksTable; at: number } | null
  /** Result of uiaAct (true = the pattern took). */
  uiaOk?: boolean
  /** An answer card is showing. */
  answer?: boolean
  /** openHelp result (false = the sheet cannot open, a text answer is used). */
  help?: boolean
}

export interface FakeA11yCalls {
  input: InputStep[][]
  uia: { elementId: string; action: UiaAction }[]
  snapshots: string[]
  scenes: A11yScene[]
  feedback: { text: string; ok: boolean }[]
  urls: string[]
  dwellPaused: boolean[]
  wake: boolean[]
  keep: boolean[]
  settings: number
  answer: string[]
  help: number
}

let seq = 0

/** An interactive UIA node with a physical rect. */
export function node(
  name: string,
  rect: Rect,
  role = 'button',
  patterns: ElementNode['patterns'] = ['invoke']
): ElementNode {
  return { id: `e${++seq}`, role, name, rect, monitorId: 1, enabled: true, patterns }
}

export interface FakeA11y {
  io: A11yIo
  calls: FakeA11yCalls
  /** The scene as the screen layer would hold it. */
  scene: A11yScene
  tick: (ms: number) => number
  /** Lets the background command run to completion. */
  settle: () => Promise<unknown>
}

export function fakeA11yIo(opts: FakeA11yOptions = {}): FakeA11y {
  const scale = opts.scale ?? 1
  let t = 1000
  let keep = opts.keep ?? false
  const calls: FakeA11yCalls = {
    input: [],
    uia: [],
    snapshots: [],
    scenes: [],
    feedback: [],
    urls: [],
    dwellPaused: [],
    wake: [],
    keep: [],
    settings: 0,
    answer: [],
    help: 0
  }
  const scene: A11yScene = {}
  const io: A11yIo = {
    now: () => t,
    input: async (steps) => {
      calls.input.push(steps)
    },
    uiaAct: async (elementId, action) => {
      calls.uia.push({ elementId, action })
      return opts.uiaOk ?? true
    },
    snapshot: async (scope) => {
      calls.snapshots.push(scope)
      return {
        snapshotId: 's1',
        nodes: opts.nodes ?? [],
        area: opts.area ?? { x: 0, y: 0, w: 1920 * scale, h: 1080 * scale }
      }
    },
    ocrLines: async () => opts.ocr ?? [],
    recentMarks: () => opts.recent ?? null,
    cachedNodes: () => opts.nodes ?? [],
    foregroundTitle: async () => opts.title ?? 'Untitled - Notepad',
    cursorLogical: () => opts.cursor ?? { x: 100, y: 100 },
    logicalToPhys: (p) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) }),
    physRectToLogical: (r) => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }),
    monitors: () => opts.monitors ?? [{ id: 1, bounds: { x: 0, y: 0, w: 1920, h: 1080 } }],
    setScene: (part) => {
      calls.scenes.push(part)
      Object.assign(scene, part)
    },
    feedback: (text, ok) => {
      calls.feedback.push({ text, ok })
    },
    openUrl: (url) => {
      calls.urls.push(url)
      return true
    },
    appUrl: (name) => (name.toLowerCase() === 'gmail' ? 'https://mail.google.com' : null),
    openSettings: () => {
      calls.settings++
    },
    openHelp: () => {
      calls.help++
      return opts.help ?? true
    },
    setDwellPaused: (paused) => {
      calls.dwellPaused.push(paused)
      return opts.dwell ?? true
    },
    setScanning: () => false,
    setWakeWord: (on) => {
      calls.wake.push(on)
    },
    setKeepMarks: (on) => {
      calls.keep.push(on)
      keep = on
    },
    keepMarks: () => keep,
    guideActive: () => opts.guide ?? false,
    answerShown: () => opts.answer ?? false,
    answer: (op) => {
      calls.answer.push(op)
      return opts.answer ?? false
    },
    log: () => {}
  }
  return {
    io,
    calls,
    scene,
    tick: (ms) => (t += ms),
    settle: () => new Promise((r) => setTimeout(r, 0))
  }
}
