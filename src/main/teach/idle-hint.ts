// Opt-in idle hint (plans 07 T33). Off by default. When on for an app and a lesson step is
// waiting (or the user asked for coach mode), N seconds without any input while that app is in
// front brings the next hint, in the bar only unless voice is on. Local only: idle time is the
// OS last-input time and "in front" is the active window's process and title. It never takes a
// screenshot; the watcher does not even exist while the feature is off. No Electron here.
import { realClock, type Clock } from '../a11y/timings'

export const IDLE_POLL_MS = 2000

export interface IdleHintConfig {
  enabled: boolean
  /** Skill ids it is on for; empty = every app. */
  apps: readonly string[]
  seconds: number
  /** Speak the hint too (else bar caption only). */
  voice: boolean
}

export interface IdleLesson {
  /** Changes with every step ("lesson#index"). */
  key: string
  appId: string | null
  /** A step is waiting for the user. */
  waiting: boolean
  /** The lesson spans apps (the Windows pack): any window counts as its app. */
  anyApp: boolean
}

export interface IdleHintDeps {
  config(): IdleHintConfig
  /** Seconds since the last keyboard or mouse input anywhere (OS idle time). */
  idleSeconds(): number
  lesson(): IdleLesson | null
  coach(): boolean
  /** The skill id of the window in front (active-window info only, no capture). */
  foregroundApp(): Promise<string | null>
  /** The next hint of the waiting step; false when there was none to give. */
  lessonHint(voice: boolean): boolean
  coachHint(appId: string, voice: boolean): void
  log(msg: string): void
  clock?: Clock
}

export function idleAppEnabled(cfg: IdleHintConfig, appId: string | null): boolean {
  return !!appId && (cfg.apps.length === 0 || cfg.apps.includes(appId))
}

export class IdleHintWatcher {
  private timer: unknown = null
  /** Hints given in the current idle stretch (reset by any input or a new step). */
  private fired = 0
  private key: string | null = null
  private busy = false

  constructor(private readonly deps: IdleHintDeps) {}

  private get clock(): Clock {
    return this.deps.clock ?? realClock
  }

  watching(): boolean {
    return this.timer !== null
  }

  private needed(): boolean {
    return this.deps.config().enabled && (!!this.deps.lesson() || this.deps.coach())
  }

  /** Starts or stops polling to match the config, the lesson and coach mode. */
  sync(): void {
    const on = this.needed()
    if (on && !this.timer) {
      this.fired = 0
      this.deps.log('idle hints: watching input idle time (no screenshots)')
      this.schedule()
    } else if (!on && this.timer) this.stop()
  }

  stop(): void {
    if (!this.timer) return
    this.clock.clearTimeout(this.timer)
    this.timer = null
    this.deps.log('idle hints: stopped')
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      void this.tick().finally(() => {
        if (this.timer) this.schedule()
      })
    }, IDLE_POLL_MS)
  }

  /** One poll (public for tests). */
  async tick(): Promise<void> {
    if (!this.needed()) {
      this.stop()
      return
    }
    if (this.busy) return
    const cfg = this.deps.config()
    const lesson = this.deps.lesson()
    const key = lesson?.key ?? null
    if (key !== this.key) {
      this.key = key
      this.fired = 0
    }
    const idle = this.deps.idleSeconds()
    if (idle < cfg.seconds) {
      this.fired = 0
      return
    }
    if (idle < cfg.seconds * (this.fired + 1)) return
    this.busy = true
    try {
      if (lesson) {
        if (!lesson.waiting || !idleAppEnabled(cfg, lesson.appId)) return
        const inFront = lesson.anyApp || (await this.deps.foregroundApp()) === lesson.appId
        if (!inFront || this.deps.lesson()?.key !== key) return
        if (this.deps.lessonHint(cfg.voice)) {
          this.fired++
          this.deps.log(`idle hint after ${Math.round(idle)} s idle (${lesson.appId})`)
        }
        return
      }
      // Coach mode: one nudge per idle stretch.
      if (this.fired > 0 || !this.deps.coach()) return
      const app = await this.deps.foregroundApp()
      if (!idleAppEnabled(cfg, app)) return
      this.fired++
      this.deps.coachHint(app!, cfg.voice)
      this.deps.log(`coach hint after ${Math.round(idle)} s idle (${app})`)
    } finally {
      this.busy = false
    }
  }
}
