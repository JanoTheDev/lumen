// Screen layer: one transparent, click-through window per display that draws the
// ScreenScene (highlights, buddy, marks, grid, annotations, dwell ring).
//
// Scene rects are kept in global logical px and translated to each display's own DIP before
// sending, so the renderer never does scaling maths (CONTRACTS C4).
import { screen, type BrowserWindow, type Display } from 'electron'
import type { GuideStep, LocateItem, Point, Rect } from '@shared/types'
import type { ScreenScene } from '@shared/events'
import type { DwellRingData, EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { onBroadcast, registerWindowSet } from './registry'
import { loadConfig } from '../config'
import { mouseEvents } from '../agent/subscriptions'

type Highlight = ScreenScene['highlights'][number]
type Scene = Omit<ScreenScene, 'monitorId'>

interface Layer {
  display: Display
  win: BrowserWindow
  ready: boolean
  /** setBounds is re-applied after the first show: Windows clamps new windows to the work area. */
  placed: boolean
  hideTimer: ReturnType<typeof setTimeout> | null
  hasScene: boolean
  hasBuddy: boolean
}

const EXIT_MS = 260
/** Locate spotlights clear themselves (surfaces.md §3.4). */
const LOCATE_MS = 6000
const FAILURE_MS = 1500

const layers = new Map<number, Layer>()
let scene: Scene = { highlights: [] }
let suppressed = false
/** Captures in flight (holdHidden); while any is held, show() keeps the layer hidden. */
let holds = 0
/** The follow buddy gets the agent's mouse-moved stream (~60 Hz while moving, nothing at rest). */
let following = false
let lastCursor: Point | null = null
let cursorDisplay: number | null = null
let captureDisplay: number | null = null

let created = false
let locateTimer: ReturnType<typeof setTimeout> | null = null

const emptyScene = (s: Scene): boolean =>
  !s.highlights.length &&
  !s.buddy &&
  !s.marks?.length &&
  !s.grid &&
  !s.annotations?.length &&
  !s.dwellUi?.scrollAt &&
  !s.dwellUi?.dragFrom &&
  !s.scan?.ring &&
  !s.scan?.menu &&
  !s.focus

/**
 * What is drawn right now. While hidden for a screenshot, the a11y numbers and grid stay up:
 * the user is choosing from them, and the model may as well see what the user sees.
 */
function visibleScene(): Scene {
  return suppressed
    ? {
        highlights: [],
        marks: scene.marks,
        grid: scene.grid,
        dwellUi: scene.dwellUi,
        scan: scene.scan
      }
    : scene
}

function intersects(r: Rect, b: Electron.Rectangle): boolean {
  return r.x < b.x + b.width && r.x + r.w > b.x && r.y < b.y + b.height && r.y + r.h > b.y
}

function contains(b: Electron.Rectangle, p: Point): boolean {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

const shift = (r: Rect, b: Electron.Rectangle): Rect => ({ ...r, x: r.x - b.x, y: r.y - b.y })
const shiftPt = (p: Point, b: Electron.Rectangle): Point => ({ x: p.x - b.x, y: p.y - b.y })

/** The part of the global scene that falls on one display, in that display's DIP. */
export function localize(s: Scene, d: { id: number; bounds: Electron.Rectangle }): ScreenScene {
  const b = d.bounds
  const out: ScreenScene = {
    monitorId: d.id,
    highlights: s.highlights
      .filter((h) => intersects(h.rect, b))
      .map((h) => ({ ...h, rect: shift(h.rect, b) }))
  }
  if (s.buddy && contains(b, s.buddy.to)) out.buddy = { ...s.buddy, to: shiftPt(s.buddy.to, b) }
  const marks = s.marks?.filter((m) => intersects(m.rect, b))
  if (marks?.length) out.marks = marks.map((m) => ({ ...m, rect: shift(m.rect, b) }))
  if (s.grid && intersects(s.grid.rect, b)) out.grid = { ...s.grid, rect: shift(s.grid.rect, b) }
  const dw = s.dwellUi
  if (dw) {
    const ui: NonNullable<ScreenScene['dwellUi']> = {}
    if (dw.scrollAt && contains(b, dw.scrollAt)) ui.scrollAt = shiftPt(dw.scrollAt, b)
    if (dw.dragFrom && contains(b, dw.dragFrom)) ui.dragFrom = shiftPt(dw.dragFrom, b)
    if (ui.scrollAt || ui.dragFrom) out.dwellUi = ui
  }
  const sc = s.scan
  if (sc) {
    const scan: NonNullable<ScreenScene['scan']> = {}
    if (sc.ring && intersects(sc.ring.rect, b))
      scan.ring = { ...sc.ring, rect: shift(sc.ring.rect, b) }
    if (sc.menu && contains(b, sc.menu.at)) scan.menu = { ...sc.menu, at: shiftPt(sc.menu.at, b) }
    if (scan.ring || scan.menu) out.scan = scan
  }
  const fx = s.focus
  if (fx) {
    const keep = fx.keep.filter((r) => intersects(r, b)).map((r) => shift(r, b))
    const labels = fx.labels?.filter((l) => intersects(l.rect, b))
    // A display with nothing kept on it is dimmed whole.
    out.focus = { level: fx.level, keep }
    if (labels?.length) out.focus.labels = labels.map((l) => ({ ...l, rect: shift(l.rect, b) }))
  }
  const ann = s.annotations?.filter((a) => a.points.some((p) => contains(b, p)))
  if (ann?.length)
    out.annotations = ann.map((a) => ({ ...a, points: a.points.map((p) => shiftPt(p, b)) }))
  return out
}

function followCursor(): boolean {
  const b = loadConfig().buddy
  return b.enabled && b.followCursor
}

/** `raise` re-asserts top-most; scene changes do, dwell ticks and cursor moves do not. */
function showLayer(l: Layer, raise = true): void {
  if (l.hideTimer) {
    clearTimeout(l.hideTimer)
    l.hideTimer = null
  }
  if (!l.ready || (suppressed && !l.hasScene)) return
  const wasVisible = l.win.isVisible()
  if (!wasVisible) {
    l.win.showInactive()
    if (!l.placed) {
      l.win.setBounds(l.display.bounds)
      l.placed = true
    }
  }
  if (!raise && wasVisible) return
  l.win.setAlwaysOnTop(true, 'screen-saver')
  l.win.moveTop()
}

function hideLater(l: Layer): void {
  if (l.hideTimer || !l.win.isVisible()) return
  l.hideTimer = setTimeout(() => {
    l.hideTimer = null
    if (!l.hasScene && !needsLayer(l)) l.win.hide()
  }, EXIT_MS)
}

/** The layer must stay up for the follow buddy or capture mode even without a scene. */
function needsLayer(l: Layer): boolean {
  return (followCursor() && cursorDisplay === l.display.id) || captureDisplay === l.display.id
}

function renderLayer(l: Layer): void {
  if (!l.ready) return
  const local = localize(visibleScene(), l.display)
  l.hasScene = !emptyScene(local)
  l.hasBuddy = !!local.buddy
  if (local.buddy) sendCursorTo(l)
  l.win.webContents.send('screen:render', local)
  if (l.hasScene || needsLayer(l)) showLayer(l)
  else hideLater(l)
}

function render(): void {
  for (const l of layers.values()) renderLayer(l)
  syncCursorFollow()
}

function sendCursorTo(l: Layer): void {
  const p = lastCursor ?? screen.getCursorScreenPoint()
  l.win.webContents.send(
    'screen:cursor',
    contains(l.display.bounds, p) ? shiftPt(p, l.display.bounds) : null
  )
}

function moveCursor(p: Point): void {
  if (lastCursor && p.x === lastCursor.x && p.y === lastCursor.y) return
  lastCursor = p
  const d = screen.getDisplayNearestPoint(p)
  const prev = cursorDisplay
  cursorDisplay = d.id
  for (const l of layers.values()) {
    if (l.display.id === d.id || l.display.id === prev) {
      sendCursorTo(l)
      if (l.display.id === d.id) showLayer(l, false)
      else if (!l.hasScene) hideLater(l)
    }
  }
}

/** Agent mouse-moved, already in global logical px. Ignored unless the buddy follows. */
export function onCursorMoved(p: Point): void {
  if (following) moveCursor(p)
}

/** mouse-moved is subscribed only while the follow buddy is on; otherwise it costs nothing. */
function syncCursorFollow(): void {
  const want = followCursor() && !suppressed
  if (want === following) return
  following = want
  mouseEvents.want('buddy-follow', want)
  if (want) {
    lastCursor = null
    moveCursor(screen.getCursorScreenPoint())
  } else {
    lastCursor = null
    cursorDisplay = null
    for (const l of layers.values()) {
      if (l.ready) l.win.webContents.send('screen:cursor', null)
      if (!l.hasScene) hideLater(l)
    }
  }
}

function createLayer(d: Display): void {
  const win = createWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    show: false
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  const l: Layer = {
    display: d,
    win,
    ready: false,
    placed: false,
    hideTimer: null,
    hasScene: false,
    hasBuddy: false
  }
  layers.set(d.id, l)
  win.webContents.on('did-finish-load', () => {
    l.ready = true
    renderLayer(l)
  })
  loadRenderer(win, 'screen')
}

function destroyLayer(id: number): void {
  const l = layers.get(id)
  if (!l) return
  if (l.hideTimer) clearTimeout(l.hideTimer)
  if (!l.win.isDestroyed()) l.win.destroy()
  layers.delete(id)
}

function syncDisplays(): void {
  const displays = screen.getAllDisplays()
  const ids = new Set(displays.map((d) => d.id))
  for (const id of [...layers.keys()]) if (!ids.has(id)) destroyLayer(id)
  for (const d of displays) {
    const l = layers.get(d.id)
    if (!l) createLayer(d)
    else if (JSON.stringify(l.display.bounds) !== JSON.stringify(d.bounds)) {
      // Scale or resolution changed: a fresh window picks up the new DPI cleanly.
      destroyLayer(d.id)
      createLayer(d)
    } else l.display = d
  }
}

/** Creates the layers once; later calls do nothing. */
export function create(): void {
  if (created) return
  created = true
  syncDisplays()
  screen.on('display-added', syncDisplays)
  screen.on('display-removed', syncDisplays)
  screen.on('display-metrics-changed', syncDisplays)
}

// ---- Scene API (old highlight-window calls map onto these) ----

export function setScene(next: Partial<Scene>): void {
  if ('highlights' in next && locateTimer) {
    clearTimeout(locateTimer)
    locateTimer = null
  }
  scene = { ...scene, ...next }
  render()
}

export function setHighlights(steps: GuideStep[]): void {
  const highlights: Highlight[] = []
  steps.forEach((s, i) => {
    if (s.bbox) {
      highlights.push({
        id: `h${i}`,
        rect: s.bbox,
        style: 'target',
        label: s.label || s.target_hint || undefined,
        n: steps.length > 1 ? i + 1 : undefined
      })
    }
  })
  setScene({ highlights })
}

export function setPointer(p: Point & { text: string }): void {
  setScene({ buddy: { to: { x: p.x, y: p.y }, label: p.text || undefined, mode: 'point' } })
}

export function setLocate(items: LocateItem[]): void {
  const highlights: Highlight[] = []
  items.forEach((it, i) => {
    if (it.bbox)
      highlights.push({
        id: `l${i}`,
        rect: it.bbox,
        style: 'dim-reveal',
        label: it.description || it.label
      })
  })
  setScene({ highlights, buddy: undefined })
  if (!highlights.length) return
  locateTimer = setTimeout(() => {
    locateTimer = null
    if (scene.highlights.every((h) => h.style === 'dim-reveal')) setScene({ highlights: [] })
  }, LOCATE_MS)
}

function flash(rect: Rect, style: 'success' | 'failure', ms: number): void {
  const id = `${style}${Date.now().toString(36)}`
  scene = { ...scene, highlights: [...scene.highlights, { id, rect, style }] }
  render()
  setTimeout(() => {
    scene = { ...scene, highlights: scene.highlights.filter((h) => h.id !== id) }
    render()
  }, ms)
}

/** Marks a rect as failed (red ring + cross) for 1.5s. Pair it with an announcement. */
export function flashFailure(rect: Rect): void {
  flash(rect, 'failure', FAILURE_MS)
}

/**
 * Drops highlights, buddy and annotations. Numbers, grid, dwell and scan belong to a11y and
 * stay; so does focus mode (only "show everything" ends it).
 */
export function clear(): void {
  if (locateTimer) clearTimeout(locateTimer)
  locateTimer = null
  scene = {
    highlights: [],
    marks: scene.marks,
    grid: scene.grid,
    dwellUi: scene.dwellUi,
    scan: scene.scan,
    focus: scene.focus
  }
  render()
}

/**
 * Hides every layer at once (screenshots). The scene comes back on show(). Layers with a11y
 * numbers or the grid stay up with only those.
 */
export function hide(): void {
  suppressed = true
  for (const l of layers.values()) {
    if (l.hideTimer) clearTimeout(l.hideTimer)
    l.hideTimer = null
    if (l.win.isDestroyed()) continue
    if (l.ready) {
      const local = localize(visibleScene(), l.display)
      l.hasScene = !emptyScene(local)
      l.hasBuddy = false
      l.win.webContents.send('screen:render', local)
    }
    if (!l.hasScene) l.win.hide()
  }
  syncCursorFollow()
}

export function show(): void {
  // A capture in flight keeps the layer hidden; its release brings the scene back.
  if (holds === 0) suppressed = false
  render()
}

/**
 * Hides every layer for one screenshot and returns the release. Holds are counted, so
 * overlapping captures keep the layer hidden until the last one is taken; the scene comes
 * back on the last release.
 */
export function holdHidden(): () => void {
  holds++
  hide()
  let released = false
  return () => {
    if (released) return
    released = true
    holds = Math.max(0, holds - 1)
    if (holds === 0 && suppressed) {
      suppressed = false
      render()
    }
  }
}

export function isVisible(): boolean {
  return !suppressed && [...layers.values()].some((l) => l.win.isVisible())
}

/** The screen:* event channels mapped onto the scene API. */
export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  const arg = args[0]
  if (channel === 'screen:highlights') setHighlights(arg as GuideStep[])
  else if (channel === 'screen:pointer') setPointer(arg as Point & { text: string })
  else if (channel === 'screen:locate') setLocate(arg as LocateItem[])
  else if (channel === 'screen:clear') clear()
}

/** The a11y dwell controller decides what the ring shows; off parks it off-screen. */
export function setDwellEnabled(enabled: boolean): void {
  if (enabled) create()
  else dwell({ x: -1e6, y: -1e6, progress: 0, active: false })
}

/** Ring position in global logical px; creates the layers on first use. */
export function dwellProgress(data: DwellRingData): void {
  create()
  dwell(data)
}

/** Dwell ring fast path: only the layer under the point gets it, in its own DIP. */
export function dwell(data: DwellRingData): void {
  const p = { x: data.x, y: data.y }
  for (const l of layers.values()) {
    if (!l.ready) continue
    if (contains(l.display.bounds, p)) {
      if (data.active) showLayer(l, false)
      const target = data.target ? shift(data.target, l.display.bounds) : undefined
      l.win.webContents.send('screen:dwell', {
        ...data,
        ...shiftPt(p, l.display.bounds),
        target
      })
    } else {
      l.win.webContents.send('screen:dwell', { ...data, active: false })
    }
  }
}

/** Capture mode: the layer under the cursor accepts pointer strokes until it reports back. */
export function setCapture(on: boolean): void {
  const target = on ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id : null
  for (const l of layers.values()) {
    const active = on && l.display.id === target
    if (active) {
      captureDisplay = l.display.id
      l.win.setIgnoreMouseEvents(false)
      l.win.setFocusable(true)
      showLayer(l)
      l.win.focus()
    } else {
      l.win.setIgnoreMouseEvents(true)
      l.win.setFocusable(false)
    }
    if (l.ready) l.win.webContents.send('screen:set-capture', active)
  }
  if (!on) {
    captureDisplay = null
    for (const l of layers.values()) if (!l.hasScene && !needsLayer(l)) hideLater(l)
  }
}

/** Converts a stroke from a layer's DIP back to global logical px. */
export function toGlobal(win: BrowserWindow | null, p: Point): Point {
  for (const l of layers.values()) {
    if (l.win === win) return { x: p.x + l.display.bounds.x, y: p.y + l.display.bounds.y }
  }
  return p
}

export function onConfigChanged(): void {
  syncCursorFollow()
  render()
}

export function windows(): BrowserWindow[] {
  return [...layers.values()].map((l) => l.win).filter((w) => !w.isDestroyed())
}

registerWindowSet(windows)
onBroadcast('settings:changed', () => onConfigChanged())
