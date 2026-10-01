// Update checks. The installed build uses electron-updater against GitHub Releases: it downloads
// in the background, checks the sha512 from latest.yml (builds are unsigned) and installs when
// the user quits. It never restarts the app on its own; "Restart to update" is a user click.
// The portable build only reads latest.yml and offers a link. Dev builds never check.
// Failures (offline, GitHub down) go to the log; only a check the user asked for shows them.
import type { UpdateMode, UpdateStatus } from '@shared/channels'
import {
  checkDue,
  FIRST_CHECK_DELAY_MS,
  isNewer,
  LATEST_FEED_URL,
  parseFeedVersion,
  releaseUrl,
  TICK_MS
} from './policy'

export interface UpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
}

/** The part of electron-updater's AppUpdater this uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  logger: UpdaterLogger | null
  on(event: string, listener: (arg: never) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface CheckResult {
  downloadPromise?: Promise<unknown> | null
}

export interface UpdateDeps {
  mode: UpdateMode
  currentVersion: string
  /** config system.autoUpdate */
  enabled: () => boolean
  isOnline: () => boolean
  loadUpdater: () => Promise<UpdaterLike>
  fetchText: (url: string) => Promise<string>
  log: (message: string) => void
  now?: () => number
}

const OFFLINE = 'You are offline.'
const FAILED = 'Could not check for updates.'

const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)

export class UpdateService {
  private st: UpdateStatus
  private updater: UpdaterLike | null = null
  private lastAttempt: number | undefined
  private manual = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private readonly now: () => number

  constructor(private readonly d: UpdateDeps) {
    this.st = { mode: d.mode, state: 'idle' }
    this.now = d.now ?? Date.now
  }

  status(): UpdateStatus {
    return { ...this.st }
  }

  /** First check a minute after start, then at most once a day while automatic updates are on. */
  start(): void {
    if (this.d.mode === 'dev') return
    const tick = (): void => {
      if (checkDue(this.d.enabled(), this.lastAttempt, this.now())) void this.check(false)
    }
    const first = setTimeout(tick, FIRST_CHECK_DELAY_MS)
    const every = setInterval(tick, TICK_MS)
    this.timers.push(first, every)
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** Config changed: downloads and install-on-quit follow the automatic-updates switch. */
  applyEnabled(): void {
    if (!this.updater) return
    const on = this.d.enabled()
    this.updater.autoDownload = on
    this.updater.autoInstallOnAppQuit = on
  }

  async check(manual = true): Promise<UpdateStatus> {
    if (this.d.mode === 'dev') return this.status()
    if (
      this.st.state === 'checking' ||
      this.st.state === 'downloading' ||
      this.st.state === 'ready'
    )
      return this.status()
    this.lastAttempt = this.now()
    if (!this.d.isOnline()) {
      this.d.log('update: offline, check skipped')
      if (manual) this.set({ state: 'error', error: OFFLINE })
      return this.status()
    }
    this.manual = manual
    this.set({ state: 'checking', error: undefined })
    try {
      if (this.d.mode === 'portable') await this.checkFeed()
      else {
        const r = (await (await this.ensureUpdater()).checkForUpdates()) as CheckResult | null
        // Download failures arrive as the 'error' event too.
        r?.downloadPromise?.catch(() => {})
      }
    } catch (e) {
      this.fail(e)
    }
    return this.status()
  }

  /** Quits and runs the downloaded installer, then starts Lumen again. User click only. */
  install(): { ok: boolean } {
    if (this.d.mode !== 'installer' || this.st.state !== 'ready' || !this.updater)
      return { ok: false }
    this.d.log(`update: restarting into ${this.st.version}`)
    this.updater.quitAndInstall(true, true)
    return { ok: true }
  }

  private async checkFeed(): Promise<void> {
    const version = parseFeedVersion(await this.d.fetchText(LATEST_FEED_URL))
    if (!version) throw new Error('latest.yml has no version')
    this.found(version, isNewer(version, this.d.currentVersion))
  }

  private found(version: string, newer: boolean): void {
    this.d.log(`update: latest ${version}, running ${this.d.currentVersion}`)
    if (newer) this.set({ state: 'available', version, url: releaseUrl(version) })
    else this.set({ state: 'up-to-date', version: undefined, url: undefined })
    this.st.checkedAt = this.now()
  }

  private fail(e: unknown): void {
    if (this.st.state === 'checking' || this.st.state === 'downloading') {
      this.d.log(`update: ${this.st.state} failed: ${short(e)}`)
      // Automatic checks fail quietly: back to what was known before.
      if (this.manual) this.set({ state: 'error', error: FAILED, percent: undefined })
      else this.set({ state: this.st.version ? 'available' : 'idle', percent: undefined })
    }
  }

  private async ensureUpdater(): Promise<UpdaterLike> {
    if (this.updater) return this.updater
    const u = await this.d.loadUpdater()
    const log = (level: string) => (m?: unknown) => this.d.log(`update ${level}: ${short(m)}`)
    u.logger = { info: log('info'), warn: log('warn'), error: log('error') }
    // Installing on quit never relaunches; only the explicit restart does.
    u.autoRunAppAfterInstall = false
    u.on('update-available', ((info: { version: string }) => {
      this.found(info.version, true)
      if (u.autoDownload) this.set({ state: 'downloading', percent: 0 })
    }) as (arg: never) => void)
    u.on('update-not-available', ((info: { version: string }) =>
      this.found(info.version, false)) as (arg: never) => void)
    u.on('download-progress', ((p: { percent: number }) => {
      if (this.st.state === 'downloading') this.st.percent = Math.round(p.percent)
    }) as (arg: never) => void)
    u.on('update-downloaded', ((info: { version: string }) => {
      this.d.log(`update: ${info.version} downloaded, installs when Lumen quits`)
      this.set({ state: 'ready', version: info.version, percent: undefined })
    }) as (arg: never) => void)
    u.on('error', ((e: unknown) => this.fail(e)) as (arg: never) => void)
    this.updater = u
    this.applyEnabled()
    return u
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.st = { ...this.st, ...patch }
  }
}
