// Event triggers for automations. Each source is live only while an enabled automation needs
// it: the agent's focus-changed hint (an app comes to the front; then only the foreground
// window's process and title are read), a process list every POLL_MS (an app closed), fs.watch
// on a folder background tasks may read (debounced per file), the system idle time (idle /
// back) and the network state (back online). No screenshots, no model calls, nothing stored.
import { join } from 'path'
import type { Automation, EventTrigger } from '@shared/automations'
import { normApp, RULE_COOLDOWN_MS, ruleMatches, SETTLE_MS, type ForegroundInfo } from './proactive'

export const POLL_MS = 30_000
/** A file is looked at once its events settle (downloads write in bursts). */
export const FILE_SETTLE_MS = 2000
/** "Back" = input within this long after an idle stretch. */
export const BACK_MS = 60_000
/** Process checks after focus changes are at most this frequent. */
const PROC_CHECK_MS = 5000

/** Partial downloads and editor temp files never count. */
const TEMP_FILE_RE = /\.(?:crdownload|part|partial|tmp|temp|download|opdownload|lock)$|^~\$|^\.|^~/i

export interface WatcherPorts {
  /** Asks for (or releases) the agent's focus-changed events. */
  focus(on: boolean): void
  /** Title + process of the foreground window (no capture). */
  foreground(): Promise<ForegroundInfo>
  /** Running process image names (e.g. "EXCEL.EXE"). */
  processes(): Promise<string[]>
  /** fs.watch on one folder; the callback gets a file name. null = could not watch. */
  watchFolder(folder: string, cb: (name: string | null) => void): (() => void) | null
  /** File names in the folder now (null = unreadable). */
  listFolder(folder: string): string[] | null
  isFile(path: string): boolean
  /** May background tasks read this folder (config agent.background.readFolders)? */
  granted(folder: string): boolean
  idleMs(): number
  online(): boolean
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  fire(id: string, detail?: string): void
}

type Ev<K extends EventTrigger['kind']> = Extract<EventTrigger, { kind: K }>

interface FolderWatch {
  stop: () => void
  known: Set<string>
  timers: Map<string, unknown>
}

export function globMatch(pattern: string | undefined, name: string): boolean {
  if (!pattern || pattern === '*' || pattern === '*.*') return true
  const re = pattern
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${re}$`, 'i').test(name)
}

const folderKey = (f: string): string => f.replace(/[\\/]+$/, '').toLowerCase()

export class AutomationWatchers {
  private list: Automation[] = []
  private focusOn = false
  private settle: unknown = null
  private lastKey = ''
  private lastOpen = new Map<string, number>()
  private appRunning = new Map<string, boolean>()
  private lastProcCheck = 0
  private procBusy = false
  private idle = new Map<string, { fired: boolean; away: boolean }>()
  private wasOnline: boolean | null = null
  private poll: unknown = null
  private folders = new Map<string, FolderWatch>()
  private problems = new Map<string, string>()

  constructor(private readonly p: WatcherPorts) {}

  private of<K extends EventTrigger['kind']>(kind: K): (Automation & { trigger: Ev<K> })[] {
    return this.list.filter(
      (a): a is Automation & { trigger: Ev<K> } => a.enabled && a.trigger.kind === kind
    )
  }

  /** Why an automation's trigger cannot fire now (folder not shared, …). */
  problem(id: string): string | undefined {
    return this.problems.get(id)
  }

  /** What is subscribed right now (tests, diagnostics). */
  live(): { focus: boolean; poll: boolean; folders: string[] } {
    return { focus: this.focusOn, poll: this.poll !== null, folders: [...this.folders.keys()] }
  }

  /** Call on start and after every change of the automations or the granted folders. */
  sync(list: Automation[]): void {
    this.list = list
    this.problems.clear()
    const apps = this.of('app')
    // Focus hint: any app trigger (close checks also look when the user switches apps).
    const wantFocus = apps.length > 0
    if (wantFocus !== this.focusOn) {
      this.focusOn = wantFocus
      this.p.focus(wantFocus)
      if (!wantFocus) {
        if (this.settle !== null) this.p.clearTimer(this.settle)
        this.settle = null
        this.lastKey = ''
      }
    }
    // Per-automation state of automations that are gone.
    const ids = new Set(list.filter((a) => a.enabled).map((a) => a.id))
    for (const m of [this.lastOpen, this.appRunning, this.idle] as Map<string, unknown>[])
      for (const id of [...m.keys()]) if (!ids.has(id)) m.delete(id)
    this.syncFolders()
    const wantPoll = this.needsPoll()
    if (wantPoll && this.poll === null) this.armPoll()
    else if (!wantPoll && this.poll !== null) {
      this.p.clearTimer(this.poll)
      this.poll = null
    }
    // The network state is learned when an online automation appears (no event for that).
    if (!this.of('online').length) this.wasOnline = null
    else if (this.wasOnline === null) this.wasOnline = this.p.online()
  }

  stop(): void {
    this.sync([])
  }

  // ---- apps ----

  /** The agent's focus-changed event (only arrives while subscribed). */
  onFocusChanged(): void {
    if (!this.focusOn) return
    if (this.settle !== null) this.p.clearTimer(this.settle)
    this.settle = this.p.setTimer(() => {
      this.settle = null
      void this.checkForeground()
    }, SETTLE_MS)
  }

  private async checkForeground(): Promise<void> {
    const apps = this.of('app')
    if (!apps.length) return
    const win = await this.p.foreground().catch(() => ({}) as ForegroundInfo)
    if (!win.process && !win.title) return
    const key = `${normApp(win.process ?? '')}|${win.process ? '' : normApp(win.title ?? '')}`
    if (key !== this.lastKey) {
      // Only a change of app counts, not focus moving inside it.
      this.lastKey = key
      const now = this.p.now()
      for (const a of apps) {
        if (!ruleMatches(a.trigger.app, win)) continue
        if (a.trigger.on === 'close') {
          this.appRunning.set(a.id, true)
          continue
        }
        const last = this.lastOpen.get(a.id)
        if (last !== undefined && now - last < RULE_COOLDOWN_MS) continue
        this.lastOpen.set(a.id, now)
        this.p.fire(a.id, `${a.trigger.app} came to the front`)
      }
    }
    // Switching apps is a good moment to see whether a watched app closed.
    if (
      apps.some((a) => a.trigger.on === 'close') &&
      this.p.now() - this.lastProcCheck >= PROC_CHECK_MS
    )
      await this.checkProcesses()
  }

  private async checkProcesses(): Promise<void> {
    const closers = this.of('app').filter((a) => a.trigger.on === 'close')
    if (!closers.length || this.procBusy) return
    this.procBusy = true
    this.lastProcCheck = this.p.now()
    try {
      const names = await this.p.processes()
      for (const a of this.of('app').filter((x) => x.trigger.on === 'close')) {
        const running = names.some((n) => ruleMatches(a.trigger.app, { process: n }))
        const before = this.appRunning.get(a.id)
        this.appRunning.set(a.id, running)
        if (before === true && !running) this.p.fire(a.id, `${a.trigger.app} was closed`)
      }
    } catch {
      /* no process list this time */
    } finally {
      this.procBusy = false
    }
  }

  // ---- polling: idle, online, closed apps ----

  private armPoll(): void {
    this.poll = this.p.setTimer(() => {
      this.poll = null
      void this.tick()
      if (this.needsPoll()) this.armPoll()
    }, POLL_MS)
  }

  private needsPoll(): boolean {
    return (
      this.of('app').some((a) => a.trigger.on === 'close') ||
      this.of('idle').length > 0 ||
      this.of('online').length > 0
    )
  }

  /** One poll (exported for tests through the timer). */
  async tick(): Promise<void> {
    const idleMs = this.p.idleMs()
    for (const a of this.of('idle')) {
      const st = this.idle.get(a.id) ?? { fired: false, away: false }
      const long = idleMs >= a.trigger.minutes * 60_000
      if (a.trigger.on === 'idle') {
        if (long && !st.fired) {
          st.fired = true
          this.p.fire(a.id, `no input for ${a.trigger.minutes} minutes`)
        } else if (idleMs < BACK_MS) st.fired = false
      } else if (long) st.away = true
      else if (st.away && idleMs < BACK_MS) {
        st.away = false
        this.p.fire(a.id, 'the user is back')
      }
      this.idle.set(a.id, st)
    }
    const online = this.of('online')
    if (online.length) {
      const now = this.p.online()
      if (this.wasOnline === false && now)
        for (const a of online) this.p.fire(a.id, 'the network is back')
      this.wasOnline = now
    }
    await this.checkProcesses()
  }

  // ---- folders ----

  private syncFolders(): void {
    const want = new Map<string, string>()
    for (const a of this.of('file')) {
      if (!this.p.granted(a.trigger.folder)) {
        this.problems.set(a.id, 'Its folder is no longer shared with background tasks.')
        continue
      }
      want.set(folderKey(a.trigger.folder), a.trigger.folder)
    }
    for (const [key, w] of [...this.folders]) {
      if (want.has(key)) continue
      w.stop()
      for (const t of w.timers.values()) this.p.clearTimer(t)
      this.folders.delete(key)
    }
    for (const [key, folder] of want) {
      if (this.folders.has(key)) continue
      const names = this.p.listFolder(folder)
      const stop = names ? this.p.watchFolder(folder, (n) => this.onFile(key, folder, n)) : null
      if (!names || !stop) {
        for (const a of this.of('file'))
          if (folderKey(a.trigger.folder) === key)
            this.problems.set(a.id, 'Its folder cannot be watched.')
        continue
      }
      this.folders.set(key, {
        stop,
        known: new Set(names.map((n) => n.toLowerCase())),
        timers: new Map()
      })
    }
  }

  private onFile(key: string, folder: string, name: string | null): void {
    const w = this.folders.get(key)
    if (!w || !name || name.includes('/') || name.includes('\\') || TEMP_FILE_RE.test(name)) return
    const prev = w.timers.get(name)
    if (prev !== undefined) this.p.clearTimer(prev)
    w.timers.set(
      name,
      this.p.setTimer(() => {
        w.timers.delete(name)
        this.checkFile(key, folder, name)
      }, FILE_SETTLE_MS)
    )
  }

  private checkFile(key: string, folder: string, name: string): void {
    const w = this.folders.get(key)
    if (!w) return
    const path = join(folder, name)
    const lower = name.toLowerCase()
    if (!this.p.isFile(path)) {
      w.known.delete(lower)
      return
    }
    const isNew = !w.known.has(lower)
    w.known.add(lower)
    for (const a of this.of('file')) {
      if (folderKey(a.trigger.folder) !== key || !globMatch(a.trigger.pattern, name)) continue
      if (a.trigger.on === 'added' && !isNew) continue
      this.p.fire(a.id, path)
    }
  }
}
