// Skill loader + registry (11 T01, CONTRACTS C10). Three locations, later overrides earlier:
// skills/builtin/<name>/ → skills/<app>/skills/<name>/ (app packs, bundled or installed) →
// ~/.ai-overlay/skills/<name>/. Only the frontmatter stays in memory; the body is read again
// when a skill is used (L2), so editing a body never changes what the prompt prefix holds.
// The user folder is watched and reloaded on change. No Electron.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher
} from 'fs'
import { join } from 'path'
import type { SkillManifest, SkillSummary, SkillTrust } from '@shared/types'
import { packMarker } from '../packs/install'
import {
  MAX_SKILL_FILE_BYTES,
  SKILL_FILE,
  SKILL_NAME_RE,
  SkillFileError,
  parseSkillFile
} from './manifest'
import { trustPin, type SkillStateStore } from './state'

/** The `.lumen` marker kind of installed skills (packs/install PackKind.name). */
export const SKILL_PACK_KIND = 'agent-skill'
/** App pack manifest (07): a folder with it is an app pack, never a skill. */
const APP_PACK_MANIFEST = 'skill.json'
/** Folders in skills/ and ~/.ai-overlay/skills that are not skills. */
export const RESERVED_DIRS = new Set(['schema', 'builtin', 'user', 'lessons', 'skills'])
const MAX_MEMOS = 64

export type SkillOrigin = SkillSummary['origin']

export interface SkillRoots {
  /** skills/builtin inside the app. */
  builtin: string
  /** skills/ inside the app: bundled app packs, each may hold skills/<name>/. */
  appPacks: string
  /** ~/.ai-overlay/skills: the user's own skills, installed skills and installed app packs. */
  user: string
}

export interface LoadedSkill {
  manifest: SkillManifest
  dir: string
  origin: SkillOrigin
  /** Trust before the user's choice (community skills start untrusted). */
  baseTrust: Exclude<SkillTrust, 'community-trusted'>
  overrides?: Exclude<SkillOrigin, 'user'>
  source?: string
  /** Community skills: the installed pack's trust pin (source + archive hash). */
  pin?: string
  hasSteps: boolean
  warnings: string[]
}

export interface SkillProblem {
  file: string
  message: string
}

export interface RegistryOptions {
  state?: SkillStateStore
  log?: (msg: string) => void
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function subdirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((n) => !n.startsWith('.') && isDir(join(root, n)))
      .sort()
  } catch {
    return []
  }
}

/** Ids of the app packs (folders with skill.json) under a skills root. */
export function appPackIds(root: string): string[] {
  return subdirs(root).filter(
    (n) => !RESERVED_DIRS.has(n) && existsSync(join(root, n, APP_PACK_MANIFEST))
  )
}

export class SkillRegistry {
  private skills = new Map<string, LoadedSkill>()
  private problemList: SkillProblem[] = []
  private conflictList: string[] = []
  private listeners = new Set<() => void>()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private memoKey = ''
  private memos = new Map<string, unknown>()

  constructor(
    readonly roots: SkillRoots,
    private readonly opts: RegistryOptions = {}
  ) {}

  /** (Re)reads every location. Broken skills are skipped and listed in problems(). */
  load(): this {
    this.generation++
    this.skills.clear()
    this.problemList = []
    this.conflictList = []
    for (const name of subdirs(this.roots.builtin))
      this.loadOne(join(this.roots.builtin, name), 'builtin', 'builtin')
    for (const [root, bundled] of [
      [this.roots.appPacks, true],
      [this.roots.user, false]
    ] as const) {
      for (const app of appPackIds(root)) {
        const appDir = join(root, app)
        const marker = bundled ? null : packMarker(appDir)
        const trust = bundled ? 'builtin' : marker ? 'community-untrusted' : 'mine'
        for (const name of subdirs(join(appDir, 'skills')))
          this.loadOne(join(appDir, 'skills', name), 'app-pack', trust, undefined, marker)
      }
    }
    for (const name of subdirs(this.roots.user)) {
      const dir = join(this.roots.user, name)
      if (RESERVED_DIRS.has(name) || existsSync(join(dir, APP_PACK_MANIFEST))) continue
      if (!existsSync(join(dir, SKILL_FILE))) continue
      const marker = packMarker(dir)
      this.loadOne(dir, 'user', marker ? 'community-untrusted' : 'mine', marker?.source, marker)
    }
    // Binds trust saved before pins existed to the packs installed now.
    for (const s of this.skills.values()) this.trustOf(s)
    for (const c of this.conflictList) this.opts.log?.(`skills: ${c}`)
    for (const p of this.problemList) this.opts.log?.(`skills: ${p.file}: ${p.message}`)
    return this
  }

  problems(): SkillProblem[] {
    return [...this.problemList]
  }

  /** Name clashes resolved by the override order, as log lines. */
  conflicts(): string[] {
    return [...this.conflictList]
  }

  all(): LoadedSkill[] {
    return [...this.sorted()]
  }

  /** Switched-on task skills, by name. Reply styles (`kind: style`) are in styles(). */
  enabled(): LoadedSkill[] {
    return [...this.enabledList()]
  }

  /**
   * A value derived from the loaded skills and their on/off and trust state, built once and
   * kept until a load or a state change. Callers must not mutate what they get back.
   */
  memo<T>(key: string, build: () => T): T {
    const version = this.version()
    if (version !== this.memoKey) {
      this.memoKey = version
      this.memos.clear()
    }
    if (this.memos.has(key)) return this.memos.get(key) as T
    const value = build()
    if (this.memos.size >= MAX_MEMOS) this.memos.clear()
    this.memos.set(key, value)
    return value
  }

  /** Changes whenever the loaded skills or their saved on/off and trust state change. */
  version(): string {
    const st = this.opts.state?.get()
    if (!st) return String(this.generation)
    const pins = Object.entries(st.pins)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
    return `${this.generation}|${st.disabled.join(',')}|${st.trusted.join(',')}|${pins.join(',')}`
  }

  private sorted(): readonly LoadedSkill[] {
    return this.memo('all', () =>
      [...this.skills.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
    )
  }

  private enabledList(): readonly LoadedSkill[] {
    return this.memo('enabled', () =>
      this.sorted().filter(
        (s) => s.manifest.kind !== 'style' && !this.opts.state?.isDisabled(s.manifest.name)
      )
    )
  }

  /** Reply styles, switched on or off. */
  styles(): LoadedSkill[] {
    return this.sorted().filter((s) => s.manifest.kind === 'style')
  }

  get(name: string): LoadedSkill | null {
    return this.skills.get(name) ?? null
  }

  isEnabled(name: string): boolean {
    return this.skills.has(name) && !this.opts.state?.isDisabled(name)
  }

  trustOf(s: LoadedSkill): SkillTrust {
    return s.baseTrust === 'community-untrusted' &&
      this.opts.state?.isTrusted(s.manifest.name, s.pin ?? trustPin({}))
      ? 'community-trusted'
      : s.baseTrust
  }

  /** Drops a saved trust that no longer matches the installed pack (after an install). */
  dropStaleTrust(name: string): void {
    const s = this.skills.get(name)
    const state = this.opts.state
    if (!s || !state?.isTrusted(name) || this.trustOf(s) === 'community-trusted') return
    state.setTrusted(name, false)
  }

  /** The SKILL.md body (L2), read now. Throws SkillFileError when the file broke since load. */
  body(name: string): string {
    const s = this.skills.get(name)
    if (!s) throw new SkillFileError(`no skill named "${name}"`)
    return parseSkillFile(readSkillText(join(s.dir, SKILL_FILE))).body
  }

  summary(s: LoadedSkill): SkillSummary {
    const m = s.manifest
    return {
      name: m.name,
      description: m.description,
      ...(m.when_to_use ? { when_to_use: m.when_to_use } : {}),
      version: m.version,
      ...(m.author ? { author: m.author } : {}),
      apps: m.apps,
      triggers: m.triggers,
      permissions: m.permissions,
      context: m.context,
      trust: this.trustOf(s),
      origin: s.origin,
      enabled: this.isEnabled(m.name),
      ...(s.overrides ? { overrides: s.overrides } : {}),
      ...(s.source ? { source: s.source } : {}),
      hasSteps: s.hasSteps,
      warnings: s.warnings
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Reloads and tells listeners (Settings edits, installs, the watcher). */
  reload(): void {
    this.load()
    for (const cb of this.listeners) cb()
  }

  /** Watches the user folder and reloads after changes settle. */
  watch(debounceMs = 300): void {
    if (this.watcher) return
    mkdirSync(this.roots.user, { recursive: true })
    try {
      this.watcher = watch(this.roots.user, { recursive: true }, () => {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          this.reload()
        }, debounceMs)
      })
      this.watcher.on('error', (e) => this.opts.log?.(`skills: watch stopped: ${e.message}`))
    } catch (e) {
      this.opts.log?.(`skills: cannot watch ${this.roots.user}: ${(e as Error).message}`)
    }
  }

  unwatch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }

  private loadOne(
    dir: string,
    origin: SkillOrigin,
    baseTrust: LoadedSkill['baseTrust'],
    source?: string,
    marker?: { source?: string; sha256?: string } | null
  ): void {
    const folder = dir.split(/[\\/]/).pop()!
    const file = join(dir, SKILL_FILE)
    if (!existsSync(file)) {
      if (origin !== 'user') this.problemList.push({ file: dir, message: `no ${SKILL_FILE}` })
      return
    }
    if (!SKILL_NAME_RE.test(folder) || RESERVED_DIRS.has(folder)) {
      this.problemList.push({ file: dir, message: 'the folder name is not a valid skill name' })
      return
    }
    let parsed: ReturnType<typeof parseSkillFile>
    try {
      parsed = parseSkillFile(readSkillText(file))
    } catch (e) {
      this.problemList.push({ file, message: (e as Error).message })
      return
    }
    const m = parsed.manifest
    if (m.name !== folder) {
      this.problemList.push({ file, message: `name "${m.name}" must match the folder "${folder}"` })
      return
    }
    const prev = this.skills.get(m.name)
    if (prev)
      this.conflictList.push(
        `"${m.name}" from ${dir} replaces the one in ${prev.dir} (${prev.origin} → ${origin})`
      )
    const overrides = prev && prev.origin !== 'user' ? prev.origin : undefined
    this.skills.set(m.name, {
      manifest: m,
      dir,
      origin,
      baseTrust,
      ...(overrides && overrides !== origin ? { overrides } : {}),
      ...(source ? { source } : {}),
      ...(marker ? { pin: trustPin(marker) } : {}),
      hasSteps: existsSync(join(dir, 'steps.json')),
      warnings: parsed.warnings
    })
  }
}

/** Reads a SKILL.md, refusing oversized files. */
export function readSkillText(file: string): string {
  const size = statSync(file).size
  if (size > MAX_SKILL_FILE_BYTES)
    throw new SkillFileError(`${SKILL_FILE} is larger than ${MAX_SKILL_FILE_BYTES / 1024} KB`)
  return readFileSync(file, 'utf8')
}
