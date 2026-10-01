// Assistant bar (ui v2): one bottom-centre surface for listening, status, answers and
// confirmations. Main owns the AssistantState; the renderer only draws it.
//
// The window is sized once per display (wide enough for the bar, 60% of the work area tall)
// and the bar animates inside it, because window bounds changes are not smooth on Windows.
// The empty area is click-through: the renderer turns mouse capture on while the pointer is
// over the card (`assistant:interactive`).
import { clipboard, screen, type BrowserWindow, type Rectangle } from 'electron'
import type { AssistantCommand, AssistantView, EventChannel, EventChannels } from '@shared/channels'
import type { AssistantPhase } from '@shared/events'
import { createWindow, loadRenderer } from './factory'
import { currentZoom, live, registerWindow, sendTo } from './registry'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { PausableTimer, answerAutoCloseMs, captionHoldMs } from '../a11y/timings'

/** Bar max width (40rem) plus room for the shadow, in CSS px before zoom. */
const BAR_WIDTH_CSS = 640 + 48
const BOTTOM_GAP = 24
/** Exit animation length before the window is really hidden. */
const HIDE_DELAY_MS = 200

export type StatusKind =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'acting'
  | 'answer'
  | 'error'
  | 'step'

let win: BrowserWindow | null = null
let card: { w: number; h: number } | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
// Pauses while the pointer (or a dwell) is on the card; "longer" extends it.
const statusTimer = new PausableTimer()
const captionTimer = new PausableTimer()
/** "Longer" multiplier for the answer auto-close; back to 1 on every new turn. */
let closeFactor = 1
let inFlight: string | null = null
let pendingConfirm: { actionId: string; resolve: (ok: boolean) => void } | null = null
let denyNextExecute = false
let turnSeq = 0

const empty = (): AssistantView => ({
  phase: 'idle',
  visible: false,
  autoCloseMs: autoCloseMs()
})
let view: AssistantView = empty()

function autoCloseMs(): number {
  return answerAutoCloseMs(loadConfig(), closeFactor)
}

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

/** Current state (tests and other main modules). */
export function state(): AssistantView {
  return view
}

function emit(): void {
  send('assistant:state', view)
}

function patch(next: Partial<AssistantView>): void {
  view = { ...view, ...next, visible: true, autoCloseMs: autoCloseMs() }
  reveal()
  emit()
}

function hasContent(): boolean {
  return !!(view.answer || view.confirm || view.notice)
}

/** Bottom-centre of the work area of the display under the cursor. */
function placement(): Rectangle {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = d.workArea
  const zoom = currentZoom(win)
  const width = Math.min(wa.width, Math.round(BAR_WIDTH_CSS * zoom))
  const height = Math.round(wa.height * 0.6)
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: wa.y + wa.height - height - BOTTOM_GAP,
    width,
    height
  }
}

function reveal(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  const w = get()
  if (!w || w.isVisible()) return
  w.setBounds(placement())
  w.showInactive()
  w.setAlwaysOnTop(true, 'screen-saver')
  w.moveTop()
}

/** Plays the exit, then hides the window so it never steals clicks while idle. */
export function close(): void {
  statusTimer.clear()
  captionTimer.clear()
  closeFactor = 1
  if (pendingConfirm) resolveConfirm(false)
  view = empty()
  emit()
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    get()?.setIgnoreMouseEvents(true, { forward: true })
    get()?.hide()
  }, HIDE_DELAY_MS)
}

/** A new turn starts: drop the previous answer, error and caption. */
export function open(phase: AssistantPhase = view.phase): void {
  statusTimer.clear()
  captionTimer.clear()
  closeFactor = 1
  view = { ...empty(), phase }
  patch({})
}

const PHASE: Record<StatusKind, AssistantPhase> = {
  idle: 'idle',
  listening: 'listening',
  transcribing: 'transcribing',
  thinking: 'thinking',
  acting: 'acting',
  answer: 'idle',
  error: 'error',
  step: 'waiting-user'
}

/** Maps the old status bubble calls onto the bar. */
export function status(
  kind: StatusKind,
  text: string,
  step?: { index: number; total: number },
  autoHideMs?: number
): void {
  statusTimer.clear()
  const phase = kind === 'step' && inFlight ? 'acting' : PHASE[kind]
  patch({
    phase,
    statusText: text,
    step: kind === 'step' && step ? { ...step, label: text } : view.step,
    error: kind === 'error' ? { message: text } : view.error
  })
  if (autoHideMs && autoHideMs > 0) statusTimer.start(autoHideMs, settle)
}

/** The status line is done: keep showing content, else close. */
export function settle(): void {
  statusTimer.clear()
  if (!view.visible) return
  if (hasContent()) patch({ phase: view.confirm ? 'confirm' : 'idle', statusText: undefined })
  else close()
}

/** The voice/query turn finished in the renderer (old `assistant:close`). */
export function turnEnded(): void {
  if (statusTimer.running || view.confirm || view.answer) return
  close()
}

export function showAnswer(text: string): void {
  const turnId = view.answer?.turnId ?? inFlight ?? `t${++turnSeq}`
  patch({
    phase: view.phase === 'error' ? 'error' : 'idle',
    statusText: undefined,
    answer: { turnId, markdown: text, streaming: false, pinned: !!view.answer?.pinned }
  })
}

/** Shows a confirm card; resolves true on confirm (or countdown end), false on deny/close. */
export function requestConfirm(c: {
  summary: string
  risk: 'low' | 'medium' | 'high'
  countdownMs?: number
}): Promise<boolean> {
  if (pendingConfirm) resolveConfirm(false)
  const actionId = `a${Date.now().toString(36)}`
  return new Promise<boolean>((resolve) => {
    pendingConfirm = { actionId, resolve }
    patch({ phase: 'confirm', confirm: { actionId, ...c } })
  })
}

function resolveConfirm(ok: boolean): void {
  const p = pendingConfirm
  if (!p) return
  pendingConfirm = null
  if (!ok) denyNextExecute = true
  view = { ...view, confirm: undefined, phase: ok ? 'acting' : 'idle' }
  p.resolve(ok)
}

/** True once after the user stopped a confirm, so the following execute is skipped. */
export function consumeDenied(): boolean {
  const d = denyNextExecute
  denyNextExecute = false
  return d
}

/** A one-line notice under the answer (e.g. "Sound is muted" with an Unmute button). */
export function setNotice(notice: AssistantView['notice']): void {
  if (!notice && !view.notice) return
  if (!notice) {
    view = { ...view, notice: undefined }
    if (view.visible) emit()
    return
  }
  patch({ notice })
}

export function copyText(text: string): void {
  clipboard.writeText(text)
}

export interface CommandDeps {
  cancel: () => void
  /** Speaks the answer again; without it Repeat only re-shows it. */
  speak?: (text: string) => void
}

let unmuteHandler: () => void = () => {}

/** What the notice's Unmute button does (set by speech/tts). */
export function setUnmuteHandler(fn: () => void): void {
  unmuteHandler = fn
}

let deps: CommandDeps = { cancel: () => {} }

export function setCommandDeps(d: CommandDeps): void {
  deps = d
}

export function command(cmd: AssistantCommand): void {
  switch (cmd.type) {
    case 'close':
      close()
      break
    case 'pin':
      if (view.answer) patch({ answer: { ...view.answer, pinned: !view.answer.pinned } })
      break
    case 'copy':
      if (view.answer?.markdown) clipboard.writeText(view.answer.markdown)
      break
    case 'repeat':
      if (view.answer) {
        deps.speak?.(view.answer.markdown)
        patch({})
      }
      break
    case 'unmute':
      unmuteHandler()
      break
    case 'cancel':
      deps.cancel()
      close()
      break
    case 'confirm':
    case 'deny':
      resolveConfirm(cmd.type === 'confirm')
      if (cmd.type === 'deny') deps.cancel()
      if (hasContent() || view.phase === 'acting') patch({})
      else close()
      break
  }
}

export function setCard(size: { w: number; h: number }): void {
  card = size
}

/** "Longer": doubles what is left of the status line and the answer auto-close. */
export function extendTimers(): boolean {
  const status = statusTimer.extend()
  const answer = !!view.answer && !view.answer.pinned && autoCloseMs() > 0
  if (answer) closeFactor *= 2
  if (status || answer) patch({})
  return status || answer
}

/** Pins (or unpins) the answer card; false when no answer is showing. */
export function pinAnswer(on = true): boolean {
  if (!view.answer || !view.visible) return false
  patch({ answer: { ...view.answer, pinned: on } })
  return true
}

/** An answer card is on screen (voice "pin", "longer", "dismiss" apply). */
export function answerShown(): boolean {
  return view.visible && !!view.answer
}

/** Dwell / hover on the card pauses timed dismissal (renderer pauses its own countdowns). */
export function holdTimers(reason: string, on: boolean): void {
  for (const t of [statusTimer, captionTimer]) {
    if (on) t.pause(reason)
    else t.resume(reason)
  }
}

export function setInteractive(on: boolean): void {
  holdTimers('hover', on)
  const w = get()
  if (!w) return
  if (on) w.setIgnoreMouseEvents(false)
  else w.setIgnoreMouseEvents(true, { forward: true })
}

/**
 * Keyboard focus into the bar (06 T17 shortcut): the window is made focusable until it loses
 * focus again, so it never steals focus otherwise. False when the bar is not showing.
 */
export function focusBar(): boolean {
  const w = get()
  if (!w || !view.visible) return false
  w.setFocusable(true)
  w.setIgnoreMouseEvents(false)
  w.focus()
  send('assistant:focus')
  w.once('blur', () => {
    if (w.isDestroyed()) return
    w.setFocusable(false)
    w.setIgnoreMouseEvents(true, { forward: true })
  })
  return true
}

/** Screen rect of the visible card, for dwell suppression. */
function hitRect(): Rectangle | null {
  const w = get()
  if (!w || !card || !view.visible) return null
  const b = w.getBounds()
  const zoom = currentZoom(win)
  const cw = card.w * zoom
  const ch = card.h * zoom
  return { x: b.x + (b.width - cw) / 2, y: b.y + b.height - ch, width: cw, height: ch }
}

export function create(): void {
  win = createWindow({
    ...placement(),
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
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.on('did-finish-load', () => emit())
  loadRenderer(win, 'assistant')
}

registerWindow(get, { zoom: true, interactive: true, hitRect })

bus.on('query.started', (e) => {
  inFlight = e.turnId
  if (!view.visible) return
  if (view.caption) return
  patch({ caption: e.prompt })
  // captionHoldMs 0 = the caption stays until the next utterance.
  const hold = captionHoldMs(loadConfig())
  if (hold > 0)
    captionTimer.start(hold, () => {
      if (view.visible && view.caption) patch({ caption: undefined })
    })
})
bus.on('query.delta', (e) => {
  if (!view.visible) return
  const prev = view.answer?.turnId === e.turnId ? view.answer.markdown : ''
  patch({
    answer: {
      turnId: e.turnId,
      markdown: prev + e.delta,
      streaming: true,
      pinned: !!view.answer?.pinned
    }
  })
})
bus.on('query.done', (e) => {
  if (inFlight === e.turnId) inFlight = null
  if (!view.visible) return
  const streamed = view.answer?.turnId === e.turnId
  const keep = streamed && e.response.mode === 'answer'
  patch({
    model: e.model ?? view.model,
    costUsd: e.cost?.usd,
    answer:
      keep && view.answer
        ? { ...view.answer, streaming: false }
        : streamed
          ? undefined
          : view.answer
  })
})
bus.on('query.failed', (e) => {
  if (inFlight === e.turnId) inFlight = null
  if (e.cancelled) return
  patch({ phase: 'error', error: { message: e.error } })
})
bus.on('query.cancelled', (e) => {
  if (inFlight === e.turnId) inFlight = null
  close()
})
bus.on('voice.cancelled', () => close())
