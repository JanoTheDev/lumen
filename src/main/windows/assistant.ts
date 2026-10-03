// Assistant bar: one bottom-centre surface for listening, status, answers and
// confirmations. Main owns the AssistantState; the renderer only draws it.
//
// The window is sized once per display (wide enough for the bar, 60% of the work area tall)
// and the bar animates inside it, because window bounds changes are not smooth on Windows.
// The empty area is click-through: the renderer turns mouse capture on while the pointer is
// over the card (`assistant:interactive`).
//
// Accessibility (06 T11): phase changes, steps, errors and confirms are announced here, once,
// through the announce policy (screen reader, TTS or shown only). Announcements nobody voiced
// are shown as a feedback line and announced by the bar's own live region.
import { clipboard, screen, type BrowserWindow, type Rectangle } from 'electron'
import type { AssistantCommand, AssistantView, EventChannel, EventChannels } from '@shared/channels'
import type { AppEvent, AssistantPhase } from '@shared/events'
import { createWindow, loadRenderer } from './factory'
import { pillBounds } from './pill-place'
import { FocusReturn, hwndOf, type ForegroundIo } from './focus-return'
import * as commandSheet from './command-sheet'
import { currentZoom, live, registerWindow, sendTo } from './registry'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { PausableTimer, answerAutoCloseMs, captionHoldMs, statusHoldMs } from '../a11y/timings'
import { screenReaderActive } from '../a11y/at-state'
import type { AnnounceOptions } from '../a11y/announce'

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
const liveTimer = new PausableTimer()
let liveSeq = 0
/** "Longer" multiplier for the answer auto-close; back to 1 on every new turn. */
let closeFactor = 1
let inFlight: string | null = null
let pendingConfirm: {
  actionId: string
  gatesExecute: boolean
  resolve: (ok: boolean) => void
} | null = null
/** Set when the user stopped an explain-before-do confirm; skips that turn's execute. */
let deniedExecute = false
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

/** How long after it was last on screen an answer is still "that" for repeat / copy by voice. */
export const RECENT_ANSWER_MS = 120_000
/** The newest answer text and when it was last on screen (survives the next recording). */
let recentAnswerText: { text: string; at: number } | null = null
/** The newest notice with a button and when it was set (the next recording hides it). */
let recentNotice: { action: NoticeAction; at: number } | null = null

type NoticeAction = NonNullable<NonNullable<AssistantView['notice']>['action']>

function patch(next: Partial<AssistantView>): void {
  view = { ...view, ...next, visible: true, autoCloseMs: autoCloseMs() }
  if (view.answer?.markdown) recentAnswerText = { text: view.answer.markdown, at: Date.now() }
  reveal()
  emit()
}

/** Captions on (deaf / hard of hearing): "I heard" keeps the bar open until dismissed. */
function captionsKept(): boolean {
  return !!view.caption && loadConfig().a11y.captions && captionHoldMs(loadConfig()) === 0
}

function hasContent(): boolean {
  return !!(
    view.answer ||
    view.confirm ||
    view.notice ||
    view.captionEdit ||
    view.agentTask ||
    view.claude ||
    captionsKept()
  )
}

/** Nothing left to show and nothing running: the bar may close. */
function idleNow(): boolean {
  return !hasContent() && !statusTimer.running && !liveTimer.running && !inFlight
}

type Say = (text: string, opts: AnnounceOptions) => void
let say: Say = () => {}

/** The announce policy (a11y/index); set once at startup. */
export function setAnnouncer(fn: Say): void {
  say = fn
}

/** Which status lines are announced, and as what. Listening is not: the mic is open. */
const STATUS_ANNOUNCE: Partial<Record<StatusKind, AnnounceOptions['kind']>> = {
  thinking: 'phase',
  acting: 'phase',
  step: 'step',
  error: 'error'
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

/** The window was moved next to the text caret for the dictation pill (04 T47). */
let nearCaret = false

/**
 * Moves the bar so its card sits next to `anchor` (the text caret, logical px) while
 * dictating; null puts it back at the bottom centre. Closing the bar also puts it back.
 */
export function placeNear(anchor: Rectangle | null): void {
  const w = get()
  if (!w) return
  if (!anchor) {
    if (nearCaret && w.isVisible()) w.setBounds(placement())
    nearCaret = false
    return
  }
  const wa = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea
  const zoom = currentZoom(win)
  w.setBounds(
    pillBounds(anchor, wa, {
      width: Math.min(wa.width, Math.round(BAR_WIDTH_CSS * zoom)),
      height: Math.round(wa.height * 0.6),
      bottomPad: Math.round(16 * zoom),
      pillHeight: Math.round(52 * zoom),
      gap: Math.round(10 * zoom)
    })
  )
  nearCaret = true
}

function reveal(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  const w = get()
  if (!w || w.isVisible()) return
  nearCaret = false
  w.setBounds(placement())
  w.showInactive()
  w.setAlwaysOnTop(true, 'screen-saver')
  w.moveTop()
}

/** Plays the exit, then hides the window so it never steals clicks while idle. */
export function close(): void {
  releaseFocus()
  statusTimer.clear()
  captionTimer.clear()
  liveTimer.clear()
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
  liveTimer.clear()
  closeFactor = 1
  // A confirm still waiting (the user is about to say yes or no) and an open caption editor
  // (spelling by voice) survive the new recording.
  view = {
    ...empty(),
    phase,
    confirm: pendingConfirm ? view.confirm : undefined,
    captionEdit: view.captionEdit,
    // A running agent task stays on the bar while the user answers or says stop.
    agentTask: view.agentTask,
    claude: view.claude
  }
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

/** A status line on the bar (listening, thinking, step n of m, errors). */
export function status(
  kind: StatusKind,
  text: string,
  step?: { index: number; total: number },
  autoHideMs?: number
): void {
  statusTimer.clear()
  const phase = kind === 'step' && inFlight ? 'acting' : PHASE[kind]
  const announceAs = STATUS_ANNOUNCE[kind]
  // "Error: x" after query.failed already announced x.
  const known = kind === 'error' && !!view.error?.message && text.includes(view.error.message)
  patch({
    phase,
    statusText: text,
    step: kind === 'step' && step ? { ...step, label: text } : view.step,
    error:
      kind === 'error'
        ? { message: text, announced: known ? view.error?.announced : undefined }
        : view.error
  })
  if (autoHideMs && autoHideMs > 0) statusTimer.start(autoHideMs, settle)
  if (announceAs && !known) say(text, { kind: announceAs })
}

/** Status line; timed lines stay at least a11y.timings.statusHoldMs (WCAG 2.2.1). */
export function setStatus(
  kind: StatusKind,
  text: string,
  step?: { index: number; total: number },
  requestedHideMs?: number
): void {
  status(kind, text, step, statusHoldMs(loadConfig(), requestedHideMs))
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
  if (statusTimer.running || liveTimer.running || view.confirm || view.answer) return
  if (view.agentTask || view.claude) return
  if (view.captionEdit || captionsKept()) return
  close()
}

/**
 * A different answer is a new card; it does not inherit the pin of the one before. `cardsId`:
 * answer cards shown under the text (05 Phase R).
 */
export function showAnswer(text: string, cardsId?: string): void {
  const turnId = view.answer?.turnId ?? inFlight ?? `t${++turnSeq}`
  const pinned =
    !!view.answer?.pinned && view.answer.markdown === text && view.answer.cardsId === cardsId
  patch({
    phase: view.phase === 'error' ? 'error' : 'idle',
    statusText: undefined,
    answer: { turnId, markdown: text, streaming: false, pinned, ...(cardsId ? { cardsId } : {}) }
  })
}

/**
 * Shows a confirm card; resolves true on confirm (or countdown end), false on deny/close.
 * `gatesExecute`: a deny also skips the execute that follows in this turn (explain-before-do).
 */
export function requestConfirm(
  c: {
    summary: string
    risk: 'low' | 'medium' | 'high'
    countdownMs?: number
    alwaysLabel?: string
  },
  opts: { gatesExecute?: boolean } = {}
): Promise<boolean> {
  if (pendingConfirm) resolveConfirm(false)
  const gatesExecute = !!opts.gatesExecute
  if (gatesExecute) deniedExecute = false
  const actionId = `a${Date.now().toString(36)}`
  return new Promise<boolean>((resolve) => {
    pendingConfirm = { actionId, gatesExecute, resolve }
    patch({ phase: 'confirm', confirm: { actionId, ...c } })
    say(`Needs OK. ${c.summary}. Say yes or stop.`, { kind: 'confirm', priority: 'assertive' })
    // Screen reader users answer with the keyboard: focus moves into the confirm.
    if (screenReaderActive()) focusBar()
  })
}

/** A confirm is waiting for yes or no. */
export function confirmPending(): boolean {
  return !!pendingConfirm
}

/** Says no to a waiting confirm without cancelling anything (a new request replaced it). */
export function dropConfirm(): void {
  if (!pendingConfirm) return
  resolveConfirm(false)
  if (view.visible) patch({})
}

function resolveConfirm(ok: boolean): void {
  const p = pendingConfirm
  if (!p) return
  pendingConfirm = null
  // The action that follows goes to the user's window, not to the bar.
  releaseFocus()
  if (!ok && p.gatesExecute) deniedExecute = true
  view = { ...view, confirm: undefined, phase: ok ? 'acting' : 'idle' }
  p.resolve(ok)
}

/** True once after the user stopped this turn's explain-before-do confirm. */
export function consumeDenied(): boolean {
  const d = deniedExecute
  deniedExecute = false
  return d
}

/** A one-line notice under the answer (e.g. "Sound is muted" with an Unmute button). */
export function setNotice(notice: AssistantView['notice']): void {
  recentNotice = notice?.action ? { action: notice.action, at: Date.now() } : null
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
  /** Speaks the answer again; without it Repeat goes through the announce policy. */
  speak?: (text: string) => void
  /** Opens (true) or closes the caption editor (T14 "correct that"). */
  edit?: (open: boolean) => void
}

let unmuteHandler: () => void = () => {}

/** What the notice's Unmute button does (set by speech/tts). */
export function setUnmuteHandler(fn: () => void): void {
  unmuteHandler = fn
}

let undoHandler: () => void = () => {}

/** What the notice's Undo button does (set by dictation command mode). */
export function setUndoHandler(fn: () => void): void {
  undoHandler = fn
}

let deps: CommandDeps = { cancel: () => {} }

/** Speaks an answer again even with spoken replies off; false when it could not. */
let repeatSpeaker: (text: string) => boolean = () => false

/** Set by a11y: Repeat (button or voice) speaks once through the screen reader or TTS. */
export function setRepeatSpeaker(fn: (text: string) => boolean): void {
  repeatSpeaker = fn
}

/** The answer on screen, else the newest one shown in the last `maxAgeMs`; null when none. */
export function recentAnswer(maxAgeMs = RECENT_ANSWER_MS, now = Date.now()): string | null {
  if (view.visible && view.answer?.markdown) return view.answer.markdown
  if (!recentAnswerText || now - recentAnswerText.at > maxAgeMs) return null
  return recentAnswerText.text
}

/** "Repeat that" by voice: the recent answer is shown again and spoken once. */
export function repeatAnswer(): boolean {
  const text = recentAnswer()
  if (!text) return false
  if (!view.visible || view.answer?.markdown !== text) showAnswer(text)
  if (!repeatSpeaker(plainText(text))) say(plainText(text), { kind: 'answer' })
  return true
}

/** "Copy the answer" by voice: the recent answer's text to the clipboard. */
export function copyAnswer(): boolean {
  const text = recentAnswer()
  if (!text) return false
  clipboard.writeText(text)
  return true
}

/**
 * The button of the notice on screen or set in the last `maxAgeMs` ("Unmute", "Undo");
 * a recording hides the notice, so the voice command still finds it.
 */
export function noticeAction(maxAgeMs = RECENT_ANSWER_MS, now = Date.now()): NoticeAction | null {
  if (view.visible && view.notice?.action) return view.notice.action
  if (!recentNotice || now - recentNotice.at > maxAgeMs) return null
  return recentNotice.action
}

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
      if (view.answer?.markdown) {
        clipboard.writeText(view.answer.markdown)
        say('Copied', { kind: 'command' })
      }
      break
    case 'repeat':
      if (view.answer) {
        if (deps.speak) deps.speak(view.answer.markdown)
        else if (!repeatSpeaker(plainText(view.answer.markdown)))
          say(plainText(view.answer.markdown), { kind: 'answer' })
        patch({})
        break
      }
      {
        // Simple mode keeps Repeat on screen: without an answer it says what the bar shows.
        const line = repeatLine(view)
        if (line) say(line, { kind: 'status', priority: 'assertive' })
      }
      break
    case 'help':
      commandSheet.show()
      break
    case 'leave':
      releaseFocus()
      if (!view.answer?.pinned && !view.agentTask && !view.captionEdit) close()
      break
    case 'edit':
      deps.edit?.(true)
      break
    case 'edit-cancel':
      deps.edit?.(false)
      break
    case 'unmute':
      unmuteHandler()
      break
    case 'undo':
      undoHandler()
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

/** What Repeat says when there is no answer: the most important line on the bar. */
export function repeatLine(v: AssistantView): string | undefined {
  const task = v.agentTask
  const running = task?.steps.find((s) => s.status === 'running')
  return (
    v.confirm?.summary ??
    v.error?.message ??
    task?.question?.text ??
    running?.label ??
    v.live?.text ??
    v.statusText?.replace(/…$/, '') ??
    v.caption
  )
}

/** Markdown to a line a screen reader can read. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---- T14 caption ("I heard: …") ----

/** Shows what was heard; it stays until the next utterance unless captionHoldMs is set. */
export function setCaption(text: string): void {
  captionTimer.clear()
  patch({ caption: text })
  const hold = captionHoldMs(loadConfig())
  if (hold > 0)
    captionTimer.start(hold, () => {
      if (!view.visible || !view.caption) return
      patch({ caption: undefined })
      if (idleNow()) close()
    })
}

/** Opens, updates or (undefined) closes the caption editor. */
export function setCaptionEdit(edit: AssistantView['captionEdit']): void {
  if (!edit && !view.captionEdit) return
  patch({ captionEdit: edit })
  if (edit) {
    focusBar()
    return
  }
  releaseFocus()
  if (idleNow()) close()
}

// ---- T11 feedback line ----

/** Kinds that already have their own row, so they never become a feedback line. */
const OWN_ROW = new Set(['error', 'confirm', 'phase'])

/**
 * An announcement (a11y.announce). It becomes the feedback line when nobody voiced it or the
 * user wants captions of what Lumen says; an error marks the error row as announced.
 */
export function onAnnounce(e: Extract<AppEvent, { type: 'a11y.announce' }>): void {
  const audible = e.via !== undefined && e.via !== 'none'
  const kind = e.kind ?? 'status'
  if (kind === 'error' && view.error && view.visible) {
    if (!!view.error.announced !== audible) patch({ error: { ...view.error, announced: audible } })
    return
  }
  const cfg = loadConfig()
  if (OWN_ROW.has(kind) || (audible && !cfg.a11y.captions)) return
  // Switch scanning moves every second or two; its highlight is on screen already.
  if (kind === 'scan' && !cfg.a11y.captions) return
  if (kind === 'answer' && view.answer) return
  // The same line again: the screen reader declined it, so the bar announces it now.
  if (view.live && view.live.text === e.text && view.visible) {
    if (view.live.audible && !audible) patch({ live: { ...view.live, audible: false } })
    return
  }
  liveTimer.clear()
  const status = view.statusText?.replace(/…$/, '')
  patch({
    live: {
      id: ++liveSeq,
      text: e.text,
      kind,
      assertive: e.priority === 'assertive',
      audible,
      echo: status === e.text.replace(/…$/, '') || undefined
    }
  })
  liveTimer.start(cfg.a11y.timings.statusHoldMs, clearLive)
}

function clearLive(): void {
  if (!view.visible || !view.live) return
  patch({ live: undefined })
  if (idleNow() && view.phase === 'idle') close()
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
  for (const t of [statusTimer, captionTimer, liveTimer]) {
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

// ---- T10 focused mode ----

const focusReturn = new FocusReturn()

/** How main finds and refocuses the user's window (the agent's active_window/focus_window). */
export function setForegroundIo(io: ForegroundIo | null): void {
  focusReturn.setIo(io)
}

/**
 * Keyboard focus into the bar (06 T17 shortcut, confirms with a screen reader, the caption
 * editor): the window the user was in is recorded first, then the bar is made focusable
 * until it loses focus again, so it never steals focus otherwise. False when the bar is not
 * showing.
 */
export function focusBar(): boolean {
  const w = get()
  if (!w || !view.visible) return false
  if (w.isFocused()) {
    send('assistant:focus')
    return true
  }
  const own = hwndOf(w.getNativeWindowHandle?.())
  void focusReturn.remember(own === null ? [] : [own]).then(() => takeFocus(w))
  return true
}

function takeFocus(w: BrowserWindow): void {
  if (w.isDestroyed() || !view.visible) return
  w.setFocusable(true)
  w.setIgnoreMouseEvents(false)
  w.focus()
  send('assistant:focus')
  w.once('blur', () => {
    if (w.isDestroyed()) return
    // Clicked into another window: that is where the user wants to be.
    focusReturn.forget()
    w.setFocusable(false)
    w.setIgnoreMouseEvents(true, { forward: true })
  })
}

/** Gives keyboard focus back to the window the user was in, when the bar has it. */
export function releaseFocus(): void {
  const w = get()
  if (!w || !w.isFocused()) {
    focusReturn.forget()
    return
  }
  const back = focusReturn.take()
  w.blur()
  w.setFocusable(false)
  w.setIgnoreMouseEvents(true, { forward: true })
  if (back !== null) focusReturn.focus(back)
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
  // A deny belongs to the turn it was given in; never skip a later turn's execute.
  deniedExecute = false
  // The query IPC captions what was heard; this covers turns started elsewhere.
  if (!view.visible || view.caption) return
  setCaption(e.prompt)
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
  say(e.error, { kind: 'error' })
})
// ---- 08 agent step list ----

bus.on('agent.task', (e) => {
  if (e.task) {
    patch({ agentTask: e.task })
    return
  }
  if (!view.agentTask) return
  view = { ...view, agentTask: undefined }
  if (!view.visible) return
  emit()
  if (idleNow() && view.phase === 'idle') close()
})

// ---- 08 T39 focused Claude Code session ----

bus.on('claude.bar', (e) => {
  if (e.view) {
    if (e.show || view.claude?.id === e.view.id) patch({ claude: e.view })
    return
  }
  if (!view.claude || (e.id && e.id !== view.claude.id)) return
  view = { ...view, claude: undefined }
  if (!view.visible) return
  emit()
  if (idleNow() && view.phase === 'idle') close()
})

bus.on('query.cancelled', (e) => {
  if (inFlight === e.turnId) inFlight = null
  close()
})
bus.on('voice.cancelled', () => {
  close()
  send('assistant:cancel-request')
})

// ---- Voice: the bar hosts the voice controller (assistant/VoiceHost) ----

/** Hands-free uses the same auto-stop-on-silence path as wake-word activation. */
export function startVoice(handsFree: boolean): void {
  send('voice:start', { mode: handsFree ? 'hands-free' : 'hold' })
}

export function startDictation(): void {
  send('voice:start', { mode: 'dictation' })
}

bus.on('voice.started', (e) => {
  open('listening')
  startVoice(e.handsFree)
})
bus.on('dictation.started', () => {
  open('listening')
  startDictation()
})
bus.on('dictation.hands-free', () => send('voice:hands-free'))
bus.on('voice.stopped', (e) => {
  if (!e.ended) send('voice:stop')
})
