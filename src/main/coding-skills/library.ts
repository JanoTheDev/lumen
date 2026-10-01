// The coding-skill library on disk, under ~/.ai-overlay/claude-code/coding-skills/:
//   library/<name>/SKILL.md (+ files of an imported skill)
//   library.json   what Lumen knows about each skill (title, source, packages, version)
//   projects.json  which skills each project uses
// and the session plugin folder: a Lumen-owned Claude Code plugin ("lumen-skills") with copies
// of a project's skills, passed to that session with --plugin-dir (session only, loaded in
// place; code.claude.com/docs/en/cli-reference + plugins/loading, checked 2026-10-01). Nothing
// is written into the project unless the user asks to "save it to the project".
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { z } from 'zod'
import { CODING_SKILL_NAME_RE, type CodingSkillInfo } from '@shared/coding-skills'
import { sanitizeSkillMd } from './skillmd'

export const PLUGIN_NAME = 'lumen-skills'
export const MAX_SKILLS = 200
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_FILES = 40

const name = z.string().regex(CODING_SKILL_NAME_RE)
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('docs'), urls: z.array(z.string().max(2000)).max(10) }),
  z.object({ kind: z.literal('import'), from: z.string().max(2000) }),
  z.object({ kind: z.literal('written') })
])
const infoSchema = z.object({
  name,
  title: z.string().max(120),
  description: z.string().max(2000),
  source: sourceSchema,
  packages: z.array(z.string().max(120)).max(20),
  version: z.string().max(60).optional(),
  updatedAt: z.number()
})
const librarySchema = z.array(infoSchema).max(MAX_SKILLS)
const projectsSchema = z
  .array(z.object({ path: z.string().min(1).max(1024), skills: z.array(name).max(30) }))
  .max(500)

function readJson(file: string): unknown {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
  } catch {
    return undefined
  }
}

function writeJson(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function samePath(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  return n(a) === n(b)
}

/** A relative file path inside a skill folder that is safe to write. */
export function safeRel(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!s || s.length > 200 || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f<>:"|?*]/.test(s)) return null
  const parts = s.split('/')
  if (parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return null
  return parts.join('/')
}

export interface SaveInput {
  info: Omit<CodingSkillInfo, 'updatedAt'>
  skillMd: string
  files?: { path: string; text: string }[]
}

export class CodingSkillLibrary {
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  get libraryDir(): string {
    return join(this.root, 'library')
  }

  list(): CodingSkillInfo[] {
    const r = librarySchema.safeParse(readJson(join(this.root, 'library.json')))
    const list = r.success ? r.data : []
    // A skill whose folder is gone is not listed.
    return list.filter((s) => existsSync(join(this.libraryDir, s.name, 'SKILL.md')))
  }

  get(n: string): CodingSkillInfo | null {
    return this.list().find((s) => s.name === n) ?? null
  }

  skillMd(n: string): string | null {
    if (!CODING_SKILL_NAME_RE.test(n)) return null
    try {
      return readFileSync(join(this.libraryDir, n, 'SKILL.md'), 'utf8')
    } catch {
      return null
    }
  }

  /** The skill's other text files (relative path → text), for an in-place edit. */
  files(n: string): { path: string; text: string }[] {
    if (!CODING_SKILL_NAME_RE.test(n)) return []
    const base = join(this.libraryDir, n)
    const out: { path: string; text: string }[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        const st = lstatSync(p)
        if (st.isDirectory()) walk(p)
        else if (st.isFile() && !(dir === base && e === 'SKILL.md'))
          out.push({ path: relative(base, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })
      }
    }
    if (existsSync(base)) walk(base)
    return out
  }

  /** Writes (or replaces) a skill: staged next to the library, then swapped in. */
  save(input: SaveInput): CodingSkillInfo {
    const info: CodingSkillInfo = infoSchema.parse({ ...input.info, updatedAt: this.now() })
    const list = this.list().filter((s) => s.name !== info.name)
    if (list.length >= MAX_SKILLS) throw new Error(`the library is full (${MAX_SKILLS} skills)`)
    const files = input.files ?? []
    if (files.length > MAX_FILES) throw new Error('the skill has too many files')
    const stage = join(this.root, `.stage-${info.name}`)
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    try {
      writeFileSync(join(stage, 'SKILL.md'), input.skillMd, 'utf8')
      for (const f of files) {
        const rel = safeRel(f.path)
        if (!rel || rel.toLowerCase() === 'skill.md') continue
        if (Buffer.byteLength(f.text) > MAX_FILE_BYTES) throw new Error(`${rel} is too large`)
        const to = join(stage, ...rel.split('/'))
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, f.text, 'utf8')
      }
      const dest = join(this.libraryDir, info.name)
      mkdirSync(this.libraryDir, { recursive: true })
      rmSync(dest, { recursive: true, force: true })
      renameSync(stage, dest)
    } catch (e) {
      rmSync(stage, { recursive: true, force: true })
      throw e
    }
    writeJson(join(this.root, 'library.json'), [...list, info])
    return info
  }

  remove(n: string): boolean {
    if (!CODING_SKILL_NAME_RE.test(n) || !this.get(n)) return false
    rmSync(join(this.libraryDir, n), { recursive: true, force: true })
    writeJson(
      join(this.root, 'library.json'),
      this.list().filter((s) => s.name !== n)
    )
    const projects = this.projects().map((p) => ({ ...p, skills: p.skills.filter((s) => s !== n) }))
    writeJson(join(this.root, 'projects.json'), projects)
    return true
  }

  // ---- projects ----

  private projects(): { path: string; skills: string[] }[] {
    const r = projectsSchema.safeParse(readJson(join(this.root, 'projects.json')))
    return r.success ? r.data : []
  }

  /** The project's skills that are still in the library. */
  attached(project: string): string[] {
    const known = new Set(this.list().map((s) => s.name))
    const p = this.projects().find((x) => samePath(x.path, project))
    return (p?.skills ?? []).filter((s) => known.has(s))
  }

  /** Projects that have the skill attached. */
  projectsWith(n: string): string[] {
    return this.projects()
      .filter((p) => p.skills.includes(n))
      .map((p) => p.path)
  }

  setAttached(project: string, skills: string[]): string[] {
    const known = new Set(this.list().map((s) => s.name))
    const next = [...new Set(skills)].filter((s) => known.has(s)).slice(0, 30)
    const rest = this.projects().filter((x) => !samePath(x.path, project))
    writeJson(
      join(this.root, 'projects.json'),
      next.length ? [...rest, { path: project, skills: next }] : rest
    )
    return next
  }

  attach(project: string, names: string[]): string[] {
    return this.setAttached(project, [...this.attached(project), ...names])
  }

  detach(project: string, n: string): string[] {
    return this.setAttached(
      project,
      this.attached(project).filter((s) => s !== n)
    )
  }

  // ---- session plugin ----

  /**
   * Builds the session's plugin folder with copies of the project's skills (fresh on every
   * spawn) and returns it, or null when the project has none (the folder is removed then).
   */
  buildPluginDir(dir: string, project: string): string | null {
    const skills = this.attached(project)
    rmSync(dir, { recursive: true, force: true })
    if (!skills.length) return null
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_NAME,
          description: 'Coding skills Lumen attached to this project.',
          version: '1.0.0'
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    for (const s of skills) {
      const to = join(dir, 'skills', s)
      copyTree(join(this.libraryDir, s), to)
      // Older entries and Settings edits: no header permissions / hooks, no load-time commands.
      try {
        const md = join(to, 'SKILL.md')
        writeFileSync(md, sanitizeSkillMd(readFileSync(md, 'utf8'), s).skillMd, 'utf8')
      } catch {
        rmSync(to, { recursive: true, force: true })
      }
    }
    return dir
  }

  /** "save it to the project": a copy in <project>/.claude/skills/<name> (only on request). */
  saveToProject(project: string, n: string): string {
    if (!CODING_SKILL_NAME_RE.test(n) || !this.get(n)) throw new Error('no such skill')
    const dest = join(project, '.claude', 'skills', n)
    if (existsSync(dest)) throw new Error(`the project already has a skill called ${n}`)
    copyTree(join(this.libraryDir, n), dest)
    return dest
  }
}

/** Plain files only (no links), inside `from`. */
export function copyTree(from: string, to: string): void {
  const base = resolve(from)
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (!resolve(p).startsWith(base + sep)) continue
      const rel = relative(base, p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) {
        mkdirSync(dirname(join(to, rel)), { recursive: true })
        cpSync(p, join(to, rel))
      }
    }
  }
  mkdirSync(to, { recursive: true })
  walk(base)
}
