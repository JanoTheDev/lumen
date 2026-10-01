// Skill registry (plans 07 T12): the bundled packs (<app>/skills) plus the user's own packs in
// ~/.ai-overlay/skills, each skill.json and lesson validated on load. A user pack with the same
// id replaces the bundled one; a user folder with only lessons/ adds lessons to it. Loose user
// lessons (made by "show me how" or migrated guides) live in ~/.ai-overlay/skills/user/lessons.
// Matching reuses the prompt-side matcher (ai/skills.ts): process, then url, then title.
// Community packs (T32, installed from a `.lumen` file) carry a marker and load as untrusted:
// their lessons lose "do it for me" (packs are data only; Lumen never acts for them).
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { matchSkill, type SkillPack, type SkillRegion } from '../ai/skills'
import { HANDOFF_FILE } from '../packs/handoff-kind'
import { packMarker, type PackTrust } from '../packs/install'
import { parseCurriculum, type Curriculum } from './curriculum'
import { parseLesson, type Lesson } from './lesson'

export type SkillSource = 'builtin' | 'user'

export interface Skill extends SkillPack {
  version: string
  bridge?: string
  source: SkillSource
  /** Installed from a community pack file (T32). */
  trust?: PackTrust
  lessons: Lesson[]
  /** curriculum.json (T28): units → lesson ids. */
  curriculum?: Curriculum
}

export interface RegistryProblem {
  file: string
  message: string
}

export interface ActiveWindowLike {
  process?: string
  exe?: string
  title?: string
  url?: string
}

const NON_PACK_DIRS = new Set(['schema', 'builtin', 'user'])
const LESSON_SUFFIX = '.lesson.json'

const skillManifest = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  match: z
    .object({
      process: z.array(z.string().min(1)).optional(),
      title: z.array(z.string().min(1)).optional(),
      url: z.array(z.string().min(1)).optional()
    })
    .strict(),
  uiaQuality: z.enum(['good', 'partial', 'none']),
  bridge: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .optional()
})

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function zodMessage(e: unknown): string {
  if (e instanceof z.ZodError)
    return e.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ')
  return (e as Error).message
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function listDirs(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).filter((n) => !NON_PACK_DIRS.has(n) && isDir(join(root, n)))
  } catch {
    return []
  }
}

function loadRegions(dir: string): Record<string, SkillRegion> {
  const out: Record<string, SkillRegion> = {}
  let regions: Record<string, Partial<SkillRegion>> = {}
  try {
    const raw = readJson(join(dir, 'regions.json')) as { regions?: typeof regions } | null
    regions = raw?.regions ?? {}
  } catch {
    return out
  }
  for (const [name, g] of Object.entries(regions)) {
    const ok = [g.x, g.y, g.w, g.h].every((n) => typeof n === 'number' && n >= 0 && n <= 1)
    if (ok && g.w! > 0 && g.h! > 0)
      out[name] = { x: g.x!, y: g.y!, w: g.w!, h: g.h!, desc: String(g.desc ?? name), page: g.page }
  }
  return out
}

export class SkillRegistry {
  private skills = new Map<string, Skill>()
  private problemList: RegistryProblem[] = []
  /** Ids of the loose user lessons (saved "show me how" lessons, migrated guides). */
  private loose = new Set<string>()
  /** Helper handoff folders (11 T24): their lessons join their apps after every pack loaded. */
  private handoffs: string[] = []

  constructor(private readonly dirs: { builtin: string; user?: string }) {}

  /** (Re)reads every pack. Broken files are skipped and listed in problems(). */
  load(): this {
    this.skills.clear()
    this.problemList = []
    this.loose.clear()
    this.handoffs = []
    for (const id of listDirs(this.dirs.builtin))
      this.loadPack(join(this.dirs.builtin, id), 'builtin')
    const user = this.dirs.user
    if (user) {
      for (const id of listDirs(user)) this.loadPack(join(user, id), 'user')
      for (const dir of this.handoffs) this.loadHandoff(dir)
      this.loadLooseLessons(join(user, 'user', 'lessons'))
    }
    return this
  }

  problems(): RegistryProblem[] {
    return this.problemList
  }

  all(): Skill[] {
    return [...this.skills.values()]
  }

  get(id: string): Skill | null {
    return this.skills.get(id) ?? null
  }

  lesson(id: string): { lesson: Lesson; skill: Skill } | null {
    for (const skill of this.skills.values()) {
      const lesson = skill.lessons.find((l) => l.id === id)
      if (lesson) return { lesson, skill }
    }
    return null
  }

  /** The pack for the foreground window: process name, then url, then title. */
  matchApp(win: ActiveWindowLike | null | undefined): Skill | null {
    if (!win) return null
    const hit = matchSkill(
      { process: win.process || win.exe, title: win.title, url: win.url },
      this.all()
    )
    return hit ? (this.skills.get(hit.id) ?? null) : null
  }

  private problem(file: string, message: string): void {
    this.problemList.push({ file, message })
  }

  private loadPack(dir: string, source: SkillSource): void {
    const manifestFile = join(dir, 'skill.json')
    if (source === 'user' && !existsSync(manifestFile) && existsSync(join(dir, HANDOFF_FILE))) {
      this.handoffs.push(dir)
      return
    }
    const trust = source === 'user' ? packMarker(dir)?.trust : undefined
    const loaded = this.loadLessons(join(dir, 'lessons'))
    const lessons = trust ? loaded.map(withoutDoIt) : loaded
    if (!existsSync(manifestFile)) {
      // Lessons-only user folder: add to (and override in) the pack with that id.
      const base = this.skills.get(dir.split(/[\\/]/).pop()!)
      if (base && lessons.length) base.lessons = mergeLessons(base.lessons, lessons)
      return
    }
    let meta: z.infer<typeof skillManifest>
    try {
      meta = skillManifest.parse(readJson(manifestFile))
    } catch (e) {
      this.problem(manifestFile, zodMessage(e))
      return
    }
    const prev = this.skills.get(meta.id)
    // A user pack replaces the bundled one but keeps bundled lessons it does not redefine.
    const all = prev ? mergeLessons(prev.lessons, lessons) : lessons
    const curriculum = this.loadCurriculum(join(dir, 'curriculum.json'), all) ?? prev?.curriculum
    this.skills.set(meta.id, {
      id: meta.id,
      name: meta.name,
      version: meta.version,
      dir,
      match: meta.match,
      uiaQuality: meta.uiaQuality,
      ...(meta.bridge ? { bridge: meta.bridge } : {}),
      regions: loadRegions(dir),
      source,
      ...(trust ? { trust } : {}),
      lessons: all,
      ...(curriculum ? { curriculum } : {})
    })
  }

  /** The pack's curriculum; a broken one is listed in problems() and ignored. */
  private loadCurriculum(file: string, lessons: Lesson[]): Curriculum | undefined {
    if (!existsSync(file)) return undefined
    try {
      const r = parseCurriculum(readJson(file), lessons)
      if ('curriculum' in r) return r.curriculum
      this.problem(file, r.error)
    } catch (e) {
      this.problem(file, zodMessage(e))
    }
    return undefined
  }

  private loadLessons(dir: string): Lesson[] {
    if (!existsSync(dir)) return []
    const out: Lesson[] = []
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(LESSON_SUFFIX))
    } catch {
      return out
    }
    for (const f of files.sort()) {
      const file = join(dir, f)
      try {
        out.push(parseLesson(readJson(file)))
      } catch (e) {
        this.problem(file, zodMessage(e))
      }
    }
    return out
  }

  /**
   * Loose user lessons: generated ones for apps without a pack and migrated guides get a
   * lessons-only skill of their own (no match rules, so it never matches a window).
   */
  private loadLooseLessons(dir: string): void {
    for (const lesson of this.loadLessons(dir)) {
      const skill = this.skills.get(lesson.app) ?? this.lessonsOnlySkill(lesson.app, dir)
      skill.lessons = mergeLessons(skill.lessons, [lesson])
      this.loose.add(lesson.id)
    }
  }

  /**
   * A helper's lessons (11 T24) join the pack of their app (so regions and matching work), or a
   * lessons-only skill. They never replace a lesson that is already there.
   */
  private loadHandoff(dir: string): void {
    const trust = packMarker(dir)?.trust
    for (const loaded of this.loadLessons(join(dir, 'lessons'))) {
      const lesson = trust ? withoutDoIt(loaded) : loaded
      if (this.lesson(lesson.id)) {
        this.problem(join(dir, 'lessons'), `lesson ${lesson.id} is already installed; skipped`)
        continue
      }
      const skill = this.skills.get(lesson.app) ?? this.lessonsOnlySkill(lesson.app, dir)
      skill.lessons = [...skill.lessons, lesson]
    }
  }

  /** The user's own loose lessons, newest file order kept. */
  userLessons(): { lesson: Lesson; skill: Skill }[] {
    return [...this.loose].flatMap((id) => this.lesson(id) ?? [])
  }

  private lessonsOnlySkill(id: string, dir: string): Skill {
    const skill: Skill = {
      id,
      name: appDisplayName(id),
      version: '0.0.0',
      dir,
      match: {},
      regions: {},
      source: 'user',
      lessons: []
    }
    this.skills.set(id, skill)
    return skill
  }
}

/** Whether a skill can match a window (lessons-only user skills cannot). */
export function hasMatchRules(skill: Skill): boolean {
  const m = skill.match
  return !!(m.process?.length || m.title?.length || m.url?.length)
}

const APP_NAMES: Record<string, string> = { general: 'Your guides' }

/** "my-app" → "My app"; "general" (migrated guides) → "Your guides". */
function appDisplayName(id: string): string {
  const named = APP_NAMES[id]
  if (named) return named
  const words = id.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The lesson with no "do it for me" actions (community packs). */
function withoutDoIt(lesson: Lesson): Lesson {
  return {
    ...lesson,
    steps: lesson.steps.map((s) => {
      if (!s.doItForMe) return s
      const copy = { ...s }
      delete copy.doItForMe
      return copy
    })
  }
}

/** Later lessons replace earlier ones with the same id; order is kept. */
function mergeLessons(base: Lesson[], over: Lesson[]): Lesson[] {
  const byId = new Map(base.map((l) => [l.id, l]))
  for (const l of over) byId.set(l.id, l)
  return [...byId.values()]
}
