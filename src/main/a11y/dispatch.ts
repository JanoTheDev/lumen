// Runs local grammar commands (06 T04/T05/T06/T07). `tryHandle` parses synchronously and
// returns at once; the work runs in the background against an injected IO layer, so the
// first input reaches the agent within a few ms of the transcript and no model is called.
import type { ElementNode, InputStep, Point, Rect, UiaAction } from '@shared/types'
import { classifyHotkey, isShellWindow, normalizeCombo } from '../actions/safety'
import type { OcrWord } from '../agent/commands'
import { shouldYield } from './coexist'
import { MouseGrid, center, type GridScene } from './grid'
import {
  MarksState,
  buildScreenMarks,
  findByName,
  isMarkRole,
  reusable,
  type Mark,
  type MarksTable
} from './marks'
import { phrase, type PhraseId } from './phrases'
import { PageReader, type ReaderState } from './reader'
import { helpTopicText } from './help-topics'
import {
  commandSheet,
  helpTopic,
  parseCommand,
  type Command,
  type CommandArgs,
  type CommandContext
} from './voice-commands'

export interface MonitorBounds {
  id: number
  /** Logical (DIP) bounds. */
  bounds: Rect
}

export interface SnapshotInfo {
  snapshotId?: string
  /** Flattened nodes, physical px. */
  nodes: ElementNode[]
  /** Physical rect the marks must fall in (foreground window, or every monitor). */
  area: Rect
}

/** The a11y part of the screen scene, in global logical px. A key that is present replaces. */
export interface A11yScene {
  marks?: { n: number; rect: Rect }[]
  grid?: GridScene
}

/** `uia_text` reply (native agent). */
export interface UiaText {
  text: string
  source: 'selection' | 'text' | 'document' | 'paragraph' | 'value' | 'name' | 'password' | 'none'
  truncated?: boolean
  role?: string
  name?: string
}

export type TextScope = 'selection' | 'focused' | 'document' | 'point'

/** Everything the dispatcher needs from the app; faked in tests. */
export interface A11yIo {
  now(): number
  /** Agent `input` steps, physical px. */
  input(steps: InputStep[]): Promise<void>
  /** UIA pattern action on a snapshot element; false when it did not take. */
  uiaAct(elementId: string, action: UiaAction): Promise<boolean>
  /** Interactive snapshot of the foreground window (or every monitor for "everywhere"). */
  snapshot(scope: 'foreground' | 'all'): Promise<SnapshotInfo | null>
  /** OCR lines of `area` when UIA is thin. */
  ocrLines(area: Rect): Promise<OcrWord[]>
  /** 05's set-of-marks table from the last turn and when it was built. */
  recentMarks(): { table: MarksTable; at: number } | null
  /** Last snapshot nodes seen by anyone (05's turn or "show numbers"), for "click <name>". */
  cachedNodes(): ElementNode[]
  /** Unnamed controls get their saved community labels (11 T13) for "click <name>". */
  labelNodes?(nodes: ElementNode[]): ElementNode[]
  foregroundTitle(): Promise<string>
  cursorLogical(): Point
  logicalToPhys(p: Point): Point
  physRectToLogical(r: Rect): Rect
  monitors(): MonitorBounds[]
  setScene(scene: A11yScene): void
  /** Status text + announcement for a handled command. */
  feedback(text: string, ok: boolean): void
  openUrl(url: string): boolean
  appUrl(name: string): string | null
  openSettings(): void
  /** Opens the "what can I say" sheet; false when it cannot (the text answer is used). */
  openHelp(): boolean
  /** False when dwell is not set up, so there is nothing to pause or resume. */
  setDwellPaused(paused: boolean): boolean
  /** False when switch scanning is not available. */
  setScanning(on: boolean): boolean
  setWakeWord(on: boolean): void
  setKeepMarks(on: boolean): void
  keepMarks(): boolean
  guideActive(): boolean
  /** A lesson runs (its words come before the grammar). */
  lessonActive?(): boolean
  /** An answer card is on screen. */
  answerShown(): boolean
  /** An answer is on screen or was in the last two minutes ("repeat that", "copy the answer"). */
  recentAnswer?(): boolean
  /**
   * Answer card / timer commands; false when there is nothing to act on. `repeat` speaks the
   * recent answer once, `copy` puts its text on the clipboard.
   */
  answer(op: 'pin' | 'longer' | 'close' | 'repeat' | 'copy'): boolean
  /** The button of the bar's notice, shown now or a moment ago ("Undo", "Unmute"); else null. */
  notice?(): 'undo' | 'unmute' | null
  /** Presses the notice's button; false when that notice is gone. */
  pressNotice?(action: 'undo' | 'unmute'): boolean
  log(msg: string): void
  /** 05 describeScreen: the spoken description. */
  describe(detail: 'brief' | 'full'): Promise<string>
  /** 05 explainTarget on the control under the pointer. */
  explainCursor(): Promise<string>
  /** UIA TextPattern text (`point` = under the pointer); null when the agent cannot. */
  readText(scope: TextScope): Promise<UiaText | null>
  /** OCR text around the pointer or of the foreground window; '' when none. */
  ocrText(where: 'cursor' | 'window'): Promise<string>
  /** Shows `text` in the bar and voices it (screen reader or Lumen's voice). */
  say(text: string): void
  /**
   * One part of a long reading: shown and voiced; Lumen's voice is cut first. Returns the id
   * Lumen's playback report carries (`speech.finished`), null when none will come.
   */
  speakPart(text: string, index: number, total: number): string | null | void
  /** Silences Lumen's voice. */
  silence(): void
  /** A screen reader or Lumen's voice can read aloud. */
  canSpeak(): boolean
  speechRate(): number
  /** Reading started, paused or stopped (status line). */
  readingChanged?(state: ReaderState): void
  simpleMode(): boolean
  /** The voice control app Lumen steps aside for (T20), or null. */
  voiceControl(): string | null
  /** Runs before a command that may change the screen (11's "what changed?" baseline). */
  beforeChange?(): Promise<void>
}

/** Commands that only show, read or set something of Lumen's own: no "what changed?" baseline. */
const NO_BASELINE =
  /^(?:marks\.(?:show|hide|more|keep)|grid\.(?:show|close)|read\.|describe\.|answer\.|lumen\.|dwell\.|scan\.|scroll\.(?:speed|stop))/

/** The command may change what is on screen (so "what changed?" should look from before it). */
export function changesScreen(id: string): boolean {
  return !NO_BASELINE.test(id)
}

/** Renderer reply for a locally handled utterance: nothing to show (feedback goes to status). */
export const LOCAL_HANDLED = { mode: 'answer', text: '', local: true, dictated: true } as const

const NOTCHES = { little: 3, normal: 5, lot: 15 } as const
/** "More detail" applies this long after a description. */
const DESCRIBED_MS = 60_000
/** Selections and fields shorter than this are said at once instead of read in parts. */
const SAY_AT_ONCE = 600
const NUDGE_PX = 50
const AUTOSCROLL_MS = 250
const START_WAIT_MS = 450
const SNAPSHOT_FRESH_MS = 10_000
const SHELL_APPS =
  /^(cmd|command prompt|powershell|power shell|terminal|windows terminal|run|regedit|registry editor|wsl|bash|ubuntu|task scheduler)$/i
// Window and Start shortcuts the user may say by name. The model-facing policy blocks every
// other Windows-key combo; these only move, show or open windows.
const SPOKEN_WIN_COMBOS = new Set(['win', 'win+up', 'win+down', 'win+left', 'win+right', 'win+d'])
const NATO: Record<string, string> = {
  alpha: 'a',
  alfa: 'a',
  bravo: 'b',
  charlie: 'c',
  delta: 'd',
  echo: 'e',
  foxtrot: 'f',
  golf: 'g',
  hotel: 'h',
  india: 'i',
  juliet: 'j',
  juliett: 'j',
  kilo: 'k',
  lima: 'l',
  mike: 'm',
  november: 'n',
  oscar: 'o',
  papa: 'p',
  quebec: 'q',
  romeo: 'r',
  sierra: 's',
  tango: 't',
  uniform: 'u',
  victor: 'v',
  whiskey: 'w',
  whisky: 'w',
  xray: 'x',
  'x-ray': 'x',
  yankee: 'y',
  zulu: 'z',
  space: ' ',
  dash: '-',
  dot: '.',
  at: '@',
  underscore: '_'
}

/** "c a t", "capital alpha bravo", "space" → "cAt"-style text; null when a word is unknown. */
export function spellOut(spoken: string): string | null {
  let out = ''
  let capital = false
  for (const raw of spoken
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)) {
    if (raw === 'capital' || raw === 'cap' || raw === 'uppercase') {
      capital = true
      continue
    }
    const ch = /^[a-z0-9]$/.test(raw) ? raw : NATO[raw]
    if (ch === undefined) return null
    out += capital ? ch.toUpperCase() : ch
    capital = false
  }
  return out || null
}

const DIR: Record<string, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
}

export class A11yCommands {
  readonly marks = new MarksState()
  readonly grid = new MouseGrid()
  private autoScroll: { timer: ReturnType<typeof setTimeout>; dir: string; speed: number } | null =
    null
  private caps = false
  private snapshotNodes: ElementNode[] = []
  private snapshotAt = 0
  /** Nodes behind the marks on screen, by element id (invoke vs click). */
  private markNodes = new Map<string, ElementNode>()
  private describedAt = -Infinity
  readonly reader: PageReader

  constructor(private readonly io: A11yIo) {
    this.reader = new PageReader({
      speak: (text, i, n) => io.speakPart(text, i, n),
      silence: () => io.silence(),
      rate: () => io.speechRate(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onChange: (state) => io.readingChanged?.(state)
    })
  }

  private phrase(id: PhraseId, vars?: Record<string, string>): string {
    return phrase(id, this.io.simpleMode(), vars)
  }

  context(): CommandContext {
    return {
      marksShown: this.marks.shown,
      gridShown: this.grid.shown,
      dragStarted: !!this.grid.dragFrom,
      guideActive: this.io.guideActive(),
      lessonActive: this.io.lessonActive?.() ?? false,
      autoScrolling: !!this.autoScroll,
      answerShown: this.io.answerShown(),
      recentAnswer: this.io.recentAnswer?.() ?? this.io.answerShown(),
      notice: this.io.notice?.() ?? null,
      reading: this.reader.active,
      described: this.io.now() - this.describedAt < DESCRIBED_MS
    }
  }

  /** The router's localGrammar hook: a response when handled, null to fall through. */
  tryHandle(utterance: string): { response: unknown } | null {
    const t0 = this.io.now()
    const ctx = this.context()
    const cmd = parseCommand(utterance, ctx)
    if (!cmd) return null
    const who = this.io.voiceControl()
    if (shouldYield(cmd, utterance, ctx, who)) {
      // The other voice control heard it too and acts on it; doing it again would double it.
      this.io.log(`local ${cmd.id} left to ${who}`)
      this.io.feedback(this.phrase('yielded', { who: who ?? '' }), true)
      return { response: LOCAL_HANDLED }
    }
    const sync = this.prepare(cmd)
    if (sync === null) return null
    this.io.log(`local ${cmd.id} ${JSON.stringify(cmd.args)} parsed in ${this.io.now() - t0}ms`)
    if (sync !== undefined) return { response: sync }
    const before = changesScreen(cmd.id) ? this.io.beforeChange : undefined
    const running = before
      ? before()
          .catch(() => {})
          .then(() => this.run(cmd))
      : this.run(cmd)
    running
      .then(() => this.io.log(`local ${cmd.id} done in ${this.io.now() - t0}ms`))
      .catch((e: Error) => {
        this.io.log(`local ${cmd.id} failed: ${e.message}`)
        this.io.feedback(failText(e, this.io.simpleMode()), false)
      })
    return { response: LOCAL_HANDLED }
  }

  /** Escape / cancel: stop auto-scroll and take numbers and the grid off the screen. */
  reset(): void {
    this.reader.stop()
    this.stopAutoScroll()
    const had = this.marks.shown || this.grid.shown
    this.marks.hide()
    this.grid.close()
    if (had) this.io.setScene({ marks: undefined, grid: undefined })
  }

  /**
   * Synchronous checks before running: null declines (router takes it), a value is the
   * response itself (nothing runs), undefined runs `cmd`.
   */
  private prepare(cmd: Command): unknown | null | undefined {
    if (cmd.id === 'pointer.click-name') {
      const known = this.knownNodes()
      const node = findByName(this.io.labelNodes?.(known) ?? known, String(cmd.args.text))
      if (!node) return null
      cmd.args.elementId = node.id
      return undefined
    }
    if (cmd.id === 'lumen.help-topic') {
      const group = helpTopic(String(cmd.args.text), this.context())
      if (!group) return null
      cmd.args.spoken = helpTopicText(group)
      return undefined
    }
    if (cmd.id === 'lumen.help') {
      if (!this.io.openHelp()) return { mode: 'answer', text: helpText(this.context()) }
      this.io.feedback('Here is what you can say', true)
      return LOCAL_HANDLED
    }
    return undefined
  }

  private knownNodes(): ElementNode[] {
    const fresh = this.io.now() - this.snapshotAt < SNAPSHOT_FRESH_MS ? this.snapshotNodes : []
    return fresh.length ? fresh : this.io.cachedNodes()
  }

  // ---- execution ----

  async run(cmd: Command): Promise<void> {
    const a = cmd.args
    switch (cmd.id) {
      case 'marks.show':
        return this.showMarks(a.scope === 'all' ? 'all' : 'foreground', a.role)
      case 'marks.hide':
        return this.hideMarks()
      case 'marks.more':
        if (!this.marks.nextPage()) this.io.feedback('No more numbers', false)
        else this.renderMarks()
        return
      case 'marks.keep':
        this.io.setKeepMarks(!!a.on)
        this.io.feedback(a.on ? 'Numbers will stay' : 'Numbers will hide after a click', true)
        return
      case 'marks.act':
        return this.actOnMark(Number(a.n), String(a.action))
      case 'marks.drag':
        return this.dragMarks(Number(a.n), Number(a.m))
      case 'marks.type':
        return this.typeInMark(Number(a.n), String(a.text))
      case 'grid.show':
        return this.showGrid(typeof a.n === 'number' ? a.n : undefined)
      case 'grid.select':
        if (!this.grid.select(Number(a.n))) this.io.feedback('That is as small as it gets', false)
        this.renderGrid()
        return
      case 'grid.act':
        return this.gridAct(String(a.action))
      case 'grid.mark':
        this.grid.markDrag()
        this.renderGrid()
        this.io.feedback('Drag start set. Pick the end, then say drop', true)
        return
      case 'grid.drop': {
        const d = this.grid.drop()
        this.renderGrid()
        if (!d) return
        await this.io.input([
          { t: 'drag', from: this.io.logicalToPhys(d.from), to: this.io.logicalToPhys(d.to) }
        ])
        this.io.feedback('Dropped', true)
        return
      }
      case 'grid.up':
        this.grid.up()
        this.renderGrid()
        return
      case 'grid.close':
        this.grid.close()
        this.renderGrid()
        return
      case 'pointer.click':
        await this.io.input([
          { t: 'click', button: a.button as 'left', count: Number(a.count) || 1 }
        ])
        this.io.feedback(label(cmd), true)
        return
      case 'pointer.move':
        return this.nudge(String(a.dir), typeof a.n === 'number' ? a.n * 10 : NUDGE_PX)
      case 'pointer.click-name':
        return this.clickElement(String(a.elementId), String(a.text))
      case 'scroll':
        return this.scroll(String(a.dir), scrollNotches(a))
      case 'scroll.edge':
        return this.keys(a.edge === 'top' ? 'ctrl+home' : 'ctrl+end', 1, label(cmd))
      case 'scroll.auto':
        return this.startAutoScroll(String(a.dir))
      case 'scroll.stop':
        this.stopAutoScroll()
        this.io.feedback('Stopped scrolling', true)
        return
      case 'scroll.speed':
        if (this.autoScroll) {
          const s = this.autoScroll.speed + (a.faster ? 1 : -1)
          this.autoScroll.speed = Math.min(5, Math.max(1, s))
        }
        return
      case 'key.press':
        return this.keys(String(a.combo), Number(a.n) || 1, label(cmd))
      case 'key.fixed':
        return this.keys(String(a.combo), Number(a.n) || Number(a.times) || 1, label(cmd))
      case 'key.type':
        return this.type(String(a.text))
      case 'key.spell': {
        const text = spellOut(String(a.text))
        if (!text) throw new UserError('I could not spell that')
        return this.type(text)
      }
      case 'key.caps':
        this.caps = !!a.on
        this.io.feedback(a.on ? 'Caps on' : 'Caps off', true)
        return
      case 'tab.n':
        return this.keys(`ctrl+${Math.min(9, Number(a.n))}`, 1, `Tab ${a.n}`)
      case 'app.open':
        return this.openApp(String(a.app))
      case 'dwell.set':
        if (!this.io.setDwellPaused(!a.on)) throw new UserError('Dwell clicking is off in settings')
        this.io.feedback(a.on ? 'Dwell on' : 'Dwell paused', true)
        return
      case 'scan.set':
        if (!this.io.setScanning(!!a.on))
          throw new UserError('Switch scanning is not available yet')
        this.io.feedback(a.on ? 'Scanning' : 'Scanning stopped', true)
        return
      case 'answer.pin':
        if (!this.io.answer('pin')) throw new UserError('No answer to pin')
        this.io.feedback('Pinned', true)
        return
      case 'answer.longer':
        if (!this.io.answer('longer')) throw new UserError('Nothing is closing')
        this.io.feedback('Twice as long', true)
        return
      case 'answer.close':
        this.io.answer('close')
        return
      case 'answer.repeat':
        if (!this.io.answer('repeat')) throw new UserError('No answer to repeat')
        return
      case 'answer.copy':
        if (!this.io.answer('copy')) throw new UserError('No answer to copy')
        this.io.feedback('Copied.', true)
        return
      case 'notice.undo':
      case 'notice.unmute': {
        const action = cmd.id === 'notice.undo' ? 'undo' : 'unmute'
        if (!this.io.pressNotice?.(action))
          throw new UserError(action === 'undo' ? 'Nothing to undo' : 'Sound is not muted')
        return
      }
      case 'lumen.help-topic':
        this.io.say(String(cmd.args.spoken))
        return
      case 'lumen.settings':
        this.io.openSettings()
        return
      case 'lumen.listen':
        this.io.setWakeWord(!!a.on)
        this.io.feedback(a.on ? 'Listening for the wake word' : 'Wake word off', true)
        return
      case 'describe.screen':
        return this.describe(a.detail === 'full' ? 'full' : 'brief')
      case 'describe.cursor':
        this.io.feedback(this.phrase('looking'), true)
        this.io.say(await this.io.explainCursor())
        return
      case 'read.selection':
        return this.readSelection()
      case 'read.page':
        return this.readPage()
      case 'read.stop':
        this.reader.stop()
        this.io.feedback(this.phrase('stopped-reading'), true)
        return
      case 'read.pause':
        if (this.reader.pause()) this.io.feedback(this.phrase('paused'), true)
        return
      case 'read.continue':
        if (!this.reader.resume()) throw new UserError(this.phrase('not-reading'))
        return
      case 'read.skip':
        if (!this.reader.skip(Number(a.by) || 1)) this.io.feedback(this.phrase('end-of-page'), true)
        return
    }
    throw new Error(`no handler for ${cmd.id}`)
  }

  // ---- describe and read (T13) ----

  private async describe(detail: 'brief' | 'full'): Promise<void> {
    this.io.feedback(this.phrase('looking'), true)
    const text = await this.io.describe(detail)
    this.describedAt = this.io.now()
    this.io.say(text)
  }

  /** Selection, else the focused field's text, else UIA text or OCR under the pointer. */
  private async readSelection(): Promise<void> {
    const sel = await this.io.readText('selection')
    if (sel?.source === 'password') throw new UserError(this.phrase('nothing-to-read'))
    let text = sel?.text.trim() ?? ''
    if (!text) {
      const focused = await this.io.readText('focused')
      if (focused && (focused.source === 'text' || focused.source === 'value'))
        text = focused.text.trim()
    }
    if (!text) {
      const at = await this.io.readText('point')
      if (at && at.source !== 'password' && at.source !== 'none') text = at.text.trim()
    }
    if (!text) text = (await this.io.ocrText('cursor')).trim()
    if (!text) throw new UserError(this.phrase('nothing-to-read'))
    this.readAloud(text)
  }

  private async readPage(): Promise<void> {
    const doc = await this.io.readText('document')
    let text = doc?.source === 'document' ? doc.text.trim() : ''
    if (!text) text = (await this.io.ocrText('window')).trim()
    if (!text) throw new UserError(this.phrase('no-page-text'))
    this.readAloud(text, true)
  }

  /** Short text is said at once; long text is read in parts that "stop" / "next" control. */
  private readAloud(text: string, page = false): void {
    if (!this.io.canSpeak()) {
      this.reader.stop()
      this.io.say(text)
      this.io.feedback(this.phrase('voice-off'), true)
      return
    }
    if (!page && text.length <= SAY_AT_ONCE) {
      this.reader.stop()
      this.io.say(text)
      return
    }
    this.reader.start(text)
  }

  // ---- numbers ----

  /** "Show numbers" (also switch scanning's Numbers). Throws UserError when nothing is found. */
  async showMarks(scope: 'foreground' | 'all', role: unknown): Promise<void> {
    const markRole = isMarkRole(role) ? role : undefined
    if (this.grid.shown) {
      this.grid.close()
      this.io.setScene({ grid: undefined })
    }
    const recent = this.io.recentMarks()
    if (
      !markRole &&
      scope === 'foreground' &&
      recent &&
      reusable(recent.table, recent.at, this.io.now())
    ) {
      this.marks.show(recent.table)
      this.markNodes = new Map(this.io.cachedNodes().map((n) => [n.id, n]))
    } else {
      const snap = await this.io.snapshot(scope)
      if (!snap) throw new UserError('I could not read this window')
      this.snapshotNodes = snap.nodes
      this.snapshotAt = this.io.now()
      let table = buildScreenMarks({ nodes: snap.nodes, area: snap.area, role: markRole })
      if (table.length < 5 && !markRole) {
        const ocr = await this.io.ocrLines(snap.area).catch(() => [])
        table = buildScreenMarks({ nodes: snap.nodes, area: snap.area, ocrLines: ocr })
      }
      this.marks.show(table, { role: markRole, snapshotId: snap.snapshotId })
      this.markNodes = new Map(snap.nodes.map((n) => [n.id, n]))
    }
    this.renderMarks()
    const count = this.marks.visible().length
    if (!count) throw new UserError('Nothing to number here')
    const more = this.marks.pages > 1 ? `, say "more numbers" for the rest` : ''
    this.io.feedback(`${count} numbers${more}`, true)
  }

  hideMarks(): void {
    this.marks.hide()
    this.renderMarks()
  }

  private renderMarks(): void {
    const marks = this.marks.shown
      ? this.marks.visible().map((m) => ({ n: m.n, rect: this.io.physRectToLogical(m.physRect) }))
      : undefined
    this.io.setScene({ marks })
  }

  private requireMark(n: number): Mark {
    const m = this.marks.find(n)
    if (!m) throw new UserError(`No number ${n} on screen`)
    return m
  }

  private afterMarkAction(): void {
    if (!this.io.keepMarks()) this.hideMarks()
  }

  private async actOnMark(n: number, action: string): Promise<void> {
    if (!this.marks.shown) {
      // "click 5" with no numbers up: show them first; the user repeats the number.
      await this.showMarks('foreground', undefined)
      this.io.feedback(`Numbers are up. Say ${n} to click it`, true)
      return
    }
    const m = this.requireMark(n)
    const at = center(m.physRect)
    const uia: UiaAction | null =
      action === 'click' ? 'invoke' : action === 'focus' ? 'focus' : null
    if (uia && m.elementId && this.canUse(m.elementId, uia)) {
      if (await this.io.uiaAct(m.elementId, uia).catch(() => false)) {
        this.io.feedback(`${actionLabel(action)} ${m.label || n}`, true)
        if (action !== 'focus') this.afterMarkAction()
        return
      }
    }
    const step: InputStep =
      action === 'focus'
        ? { t: 'move', ...at }
        : {
            t: 'click',
            button: action === 'right' ? 'right' : 'left',
            count: action === 'double' ? 2 : 1,
            ...at
          }
    await this.io.input([step])
    this.io.feedback(`${actionLabel(action)} ${m.label || n}`, true)
    if (action !== 'focus') this.afterMarkAction()
  }

  private canUse(elementId: string, action: UiaAction): boolean {
    const node = this.markNodes.get(elementId)
    if (!node) return false
    return action === 'focus' || node.patterns.includes('invoke')
  }

  private async dragMarks(n: number, m: number): Promise<void> {
    const from = center(this.requireMark(n).physRect)
    const to = center(this.requireMark(m).physRect)
    await this.io.input([{ t: 'drag', from, to }])
    this.io.feedback(`Dragged ${n} to ${m}`, true)
    this.afterMarkAction()
  }

  private async typeInMark(n: number, text: string): Promise<void> {
    const at = center(this.requireMark(n).physRect)
    await this.io.input([
      { t: 'click', button: 'left', ...at },
      { t: 'wait', ms: 80 }
    ])
    await this.type(text)
    this.afterMarkAction()
  }

  // ---- grid ----

  /** "Mouse grid [n]": the given monitor, else the one under the cursor. */
  showGrid(monitor?: number, opts: { quiet?: boolean } = {}): void {
    const mons = [...this.io.monitors()].sort(
      (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
    )
    let target: MonitorBounds | undefined
    if (monitor !== undefined) {
      target = mons[monitor - 1]
      if (!target) throw new UserError(`There is no monitor ${monitor}`)
    } else {
      const c = this.io.cursorLogical()
      target =
        mons.find(
          (m) =>
            c.x >= m.bounds.x &&
            c.x < m.bounds.x + m.bounds.w &&
            c.y >= m.bounds.y &&
            c.y < m.bounds.y + m.bounds.h
        ) ?? mons[0]
    }
    if (!target) throw new UserError('No screen found')
    this.marks.hide()
    this.grid.show(target.bounds, target.id)
    this.io.setScene({ marks: undefined, grid: this.grid.scene() })
    if (!opts.quiet) this.io.feedback('Say a number from 1 to 9', true)
  }

  renderGrid(): void {
    this.io.setScene({ grid: this.grid.scene() })
  }

  private async gridAct(action: string): Promise<void> {
    const p = this.grid.target()
    if (!p) return
    const at = this.io.logicalToPhys(p)
    this.grid.close()
    this.renderGrid()
    await this.io.input([
      {
        t: 'click',
        button: action === 'right' ? 'right' : 'left',
        count: action === 'double' ? 2 : 1,
        ...at
      }
    ])
    this.io.feedback(actionLabel(action), true)
  }

  // ---- pointer, scroll, keys ----

  private async nudge(dir: string, px: number): Promise<void> {
    const d = DIR[dir]
    const c = this.io.cursorLogical()
    const to = this.io.logicalToPhys({ x: c.x + d.x * px, y: c.y + d.y * px })
    await this.io.input([{ t: 'move', ...to }])
  }

  private async clickElement(elementId: string, name: string): Promise<void> {
    const node = this.knownNodes().find((n) => n.id === elementId)
    if (
      node?.patterns.includes('invoke') &&
      (await this.io.uiaAct(elementId, 'invoke').catch(() => false))
    ) {
      this.io.feedback(`Clicked ${name}`, true)
      return
    }
    if (!node) throw new UserError(`I could not find ${name}`)
    await this.io.input([{ t: 'click', button: 'left', ...center(node.rect) }])
    this.io.feedback(`Clicked ${name}`, true)
  }

  private async scroll(dir: string, notches: number): Promise<void> {
    const d = DIR[dir]
    await this.io.input([{ t: 'scroll', dx: d.x * notches, dy: d.y * notches }])
    this.io.feedback(`Scrolling ${dir}`, true)
  }

  private startAutoScroll(dir: string): void {
    this.stopAutoScroll()
    const d = DIR[dir]
    // Each tick waits for the previous scroll, so a slow agent never gets a backlog.
    const tick = (): void => {
      this.io
        .input([{ t: 'scroll', dx: d.x * state.speed, dy: d.y * state.speed }])
        .then(() => {
          if (this.autoScroll === state) state.timer = setTimeout(tick, AUTOSCROLL_MS)
        })
        .catch(() => {
          if (this.autoScroll === state) this.stopAutoScroll()
        })
    }
    const state = { dir, speed: 1, timer: setTimeout(tick, AUTOSCROLL_MS) }
    this.autoScroll = state
    this.io.feedback(`Scrolling ${dir}. Say stop to stop`, true)
  }

  stopAutoScroll(): void {
    if (this.autoScroll) clearTimeout(this.autoScroll.timer)
    this.autoScroll = null
  }

  private async keys(combo: string, times: number, what: string): Promise<void> {
    // The user said this shortcut themselves, so "confirm" is satisfied; "deny" never runs.
    if (!SPOKEN_WIN_COMBOS.has(normalizeCombo(combo))) {
      const verdict = classifyHotkey(combo, { windowTitle: await this.io.foregroundTitle() })
      if (verdict === 'deny') throw new UserError(`${combo} is blocked for safety`)
    }
    const steps: InputStep[] = []
    for (let i = 0; i < Math.min(times, 50); i++) steps.push({ t: 'keys', combo })
    await this.io.input(steps)
    this.io.feedback(what, true)
  }

  private async type(text: string): Promise<void> {
    if (isShellWindow(await this.io.foregroundTitle()))
      throw new UserError('I do not type into terminals by voice command')
    await this.io.input([{ t: 'type', text: this.caps ? text.toUpperCase() : text }])
    this.io.feedback('Typed', true)
  }

  private async openApp(app: string): Promise<void> {
    if (SHELL_APPS.test(app.trim())) throw new UserError(`I do not open ${app} by voice command`)
    const url = this.io.appUrl(app)
    if (url && this.io.openUrl(url)) {
      this.io.feedback(`Opening ${app}`, true)
      return
    }
    // Start menu search: Ctrl+Esc opens Start without a Windows-key combo.
    await this.io.input([
      { t: 'keys', combo: 'ctrl+esc' },
      { t: 'wait', ms: START_WAIT_MS },
      { t: 'type', text: app },
      { t: 'wait', ms: START_WAIT_MS },
      { t: 'keys', combo: 'enter' }
    ])
    this.io.feedback(`Opening ${app}`, true)
  }
}

export class UserError extends Error {}

function failText(e: Error, simple: boolean): string {
  if (e instanceof UserError) return e.message
  const code = (e as Error & { code?: unknown }).code
  if (code === 'E_DENIED' || /denied/i.test(e.message)) return phrase('blocked', simple)
  if (code === 'E_UNSUPPORTED') return phrase('unsupported', simple)
  return phrase('failed', simple)
}

function scrollNotches(a: CommandArgs): number {
  const base = NOTCHES[(a.amount as keyof typeof NOTCHES) ?? 'normal'] ?? NOTCHES.normal
  return Math.min(100, base * (Number(a.n) || 1))
}

function actionLabel(action: string): string {
  return action === 'double'
    ? 'Double clicked'
    : action === 'right'
      ? 'Right clicked'
      : action === 'focus'
        ? 'Moved to'
        : 'Clicked'
}

function label(cmd: Command): string {
  const a = cmd.args
  if (cmd.id === 'pointer.click')
    return a.count === 2 ? 'Double click' : a.button === 'left' ? 'Click' : `${a.button} click`
  if (cmd.id === 'scroll.edge') return a.edge === 'top' ? 'Top' : 'Bottom'
  if (typeof a.combo === 'string') return `✓ ${a.combo}`
  return `✓ ${cmd.id}`
}

function helpText(ctx: CommandContext): string {
  const rows = commandSheet(ctx)
  const by = new Map<string, string[]>()
  for (const r of rows) by.set(r.category, [...(by.get(r.category) ?? []), r.say])
  const lines = [...by.entries()].map(
    ([cat, says]) => `**${cat[0].toUpperCase()}${cat.slice(1)}:** ${says.slice(0, 8).join(' · ')}`
  )
  return `You can say:\n\n${lines.join('\n\n')}`
}
