// Coding skills for the Claude Code copilot: one review draft at a time (from docs, an import or
// the user's words, or an update of a saved skill with its diff), the library, and per-project
// attachments with suggestions from the project's dependencies. Electron-free; the model, the
// fetches and the clock are injected. `changed(projects)` tells the copilot which projects'
// sessions need their plugin folder rebuilt.
import type {
  CodingSkillDraft,
  CodingSkillInfo,
  CodingSkillsOverview,
  CodingSkillsProject,
  CodingSkillSource
} from '@shared/coding-skills'
import { skillFromAuthor, type AuthorSkill } from './authored'
import { catalogFor, detectDependencies, suggestSkills, type CatalogEntry } from './detect'
import { skillFromDocs, skillFromText, type DistillDeps, type SkillFromModel } from './distill'
import { importSkill, type ImportDeps } from './importer'
import type { CodingSkillLibrary } from './library'
import { lineDiff, parseSkillMd, reviewWarnings } from './skillmd'

export const DRAFT_TTL_MS = 30 * 60_000

export interface CodingSkillsDeps {
  library: CodingSkillLibrary
  distill: Omit<DistillDeps, 'signal'>
  import?: ImportDeps
  /** Lumen's model-authored skills (skills/compose authorSkill) for "write your own". */
  author?: AuthorSkill
  now: () => number
  newId: () => string
  /** Projects whose sessions should reload their skills. */
  changed?: (projects: string[]) => void
  log?: (msg: string) => void
}

type InternalDraft = CodingSkillDraft & { attachTo?: string }

function hostsOf(urls: string[]): string[] {
  return urls.flatMap((u) => {
    try {
      return [new URL(u).hostname]
    } catch {
      return []
    }
  })
}

export class CodingSkills {
  private draft: InternalDraft | null = null

  constructor(private readonly deps: CodingSkillsDeps) {}

  get library(): CodingSkillLibrary {
    return this.deps.library
  }

  overview(): CodingSkillsOverview {
    return {
      library: this.deps.library.list(),
      draft: this.currentDraft(),
      dir: this.deps.library.libraryDir
    }
  }

  currentDraft(): CodingSkillDraft | null {
    if (this.draft && this.deps.now() - this.draft.createdAt > DRAFT_TTL_MS) this.draft = null
    if (!this.draft) return null
    const { attachTo: _attachTo, ...d } = this.draft
    void _attachTo
    return d
  }

  discard(): boolean {
    const had = !!this.currentDraft()
    this.draft = null
    return had
  }

  private makeDraft(
    m: {
      name: string
      title: string
      description: string
      skillMd: string
      packages: string[]
      version?: string
    },
    source: CodingSkillSource,
    files: { path: string; text: string }[],
    extraWarnings: string[],
    attachTo?: string
  ): CodingSkillDraft {
    const hosts = source.kind === 'docs' ? hostsOf(source.urls) : []
    const old = this.deps.library.skillMd(m.name)
    const draft: InternalDraft = {
      id: this.deps.newId(),
      name: m.name,
      title: m.title,
      description: m.description,
      skillMd: m.skillMd,
      source,
      packages: m.packages,
      ...(m.version ? { version: m.version } : {}),
      files,
      warnings: [...extraWarnings, ...reviewWarnings(m.skillMd, hosts)],
      ...(old !== null
        ? { update: { diff: lineDiff(old, m.skillMd), changed: old !== m.skillMd } }
        : {}),
      createdAt: this.deps.now(),
      ...(attachTo ? { attachTo } : {})
    }
    this.draft = draft
    return this.currentDraft()!
  }

  /** "add a skill for better-auth from https://…" (`url` optional for catalog libraries). */
  async fromDocs(
    req: { url?: string; title?: string; version?: string; attachTo?: string },
    signal?: AbortSignal
  ): Promise<CodingSkillDraft> {
    const entry: CatalogEntry | null = req.title ? catalogFor(req.title) : null
    const url = req.url ?? entry?.docsUrl
    if (!url) throw new Error(`I need the docs link for ${req.title ?? 'that library'}`)
    const m = await skillFromDocs(
      url,
      { title: entry?.title ?? req.title, version: req.version },
      { ...this.deps.distill, signal }
    )
    // A catalog library keeps its well-known name and packages.
    const fixed: SkillFromModel = entry
      ? {
          ...m,
          name: entry.name,
          skillMd: m.skillMd.replace(/^name: .*$/m, `name: ${entry.name}`),
          packages: [...new Set([...entry.packages, ...m.packages])]
        }
      : m
    return this.makeDraft(fixed, { kind: 'docs', urls: fixed.sources }, [], [], req.attachTo)
  }

  /** "write a coding skill for <title>: <text>". */
  async fromText(
    title: string,
    text: string,
    signal?: AbortSignal,
    attachTo?: string
  ): Promise<CodingSkillDraft> {
    if (this.deps.author) {
      const a = await skillFromAuthor(this.deps.author, title, text)
      return this.makeDraft(a, { kind: 'written' }, a.files, [], attachTo)
    }
    const m = await skillFromText(title, text, { ...this.deps.distill, signal })
    return this.makeDraft(m, { kind: 'written' }, [], [], attachTo)
  }

  /** "import the skill from <folder or GitHub link>". */
  async fromImport(
    from: string,
    pick?: string,
    signal?: AbortSignal,
    attachTo?: string
  ): Promise<CodingSkillDraft> {
    const s = await importSkill(from, pick, { ...this.deps.import, signal })
    const title = s.parsed.name
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    const warnings = s.scripts.length
      ? [`has scripts Claude may run: ${s.scripts.slice(0, 6).join(', ')}`]
      : []
    return this.makeDraft(
      {
        name: s.parsed.name,
        title,
        description: s.parsed.description,
        skillMd: s.skillMd,
        packages: [],
        ...(s.parsed.version ? { version: s.parsed.version } : {})
      },
      { kind: 'import', from: s.from },
      s.files,
      warnings,
      attachTo
    )
  }

  /** "update the better-auth skill": fetch again (or import again) → a draft with the diff. */
  async update(name: string, signal?: AbortSignal): Promise<CodingSkillDraft> {
    const info = this.deps.library.get(name)
    if (!info) throw new Error(`there is no coding skill called ${name}`)
    if (info.source.kind === 'written')
      throw new Error(
        `you wrote the ${info.title} skill yourself; edit it in Settings → Claude Code`
      )
    let d: CodingSkillDraft
    if (info.source.kind === 'docs') {
      const url = info.source.urls[0]
      if (!url) throw new Error('that skill has no docs link to read again')
      const m = await skillFromDocs(
        url,
        { title: info.title, version: info.version },
        {
          ...this.deps.distill,
          signal
        }
      )
      d = this.makeDraft(
        {
          ...m,
          name: info.name,
          title: info.title,
          skillMd: m.skillMd.replace(/^name: .*$/m, `name: ${info.name}`),
          packages: [...new Set([...info.packages, ...m.packages])]
        },
        { kind: 'docs', urls: m.sources },
        [],
        []
      )
    } else {
      d = await this.fromImport(info.source.from, info.name, signal)
      if (d.name !== info.name) {
        this.draft = null
        throw new Error('the source no longer has that skill')
      }
    }
    return d
  }

  /** Saves the draft (optionally the user's edited SKILL.md). Returns the saved skill. */
  save(id: string, editedMd?: string): CodingSkillInfo {
    const d = this.draft
    if (!d || d.id !== id || !this.currentDraft()) throw new Error('that draft is gone')
    const skillMd = editedMd ?? d.skillMd
    const parsed = parseSkillMd(skillMd, d.name)
    const before = this.deps.library.get(parsed.name)
    const info = this.deps.library.save({
      info: {
        name: parsed.name,
        title: before && parsed.name !== d.name ? before.title : d.title,
        description: parsed.description.slice(0, 2000),
        source: d.source,
        packages: d.packages.length ? d.packages : (before?.packages ?? []),
        ...(parsed.version || d.version
          ? { version: (parsed.version ?? d.version)!.slice(0, 60) }
          : {})
      },
      skillMd,
      files: d.files
    })
    this.draft = null
    const projects = new Set<string>()
    if (d.attachTo) {
      this.deps.library.attach(d.attachTo, [info.name])
      projects.add(d.attachTo)
    }
    for (const p of this.projectsUsing(info.name)) projects.add(p)
    if (projects.size) this.deps.changed?.([...projects])
    return info
  }

  /** Settings → edit a saved skill's SKILL.md in place (the name stays). */
  edit(name: string, skillMd: string): CodingSkillInfo {
    const info = this.deps.library.get(name)
    if (!info) throw new Error(`there is no coding skill called ${name}`)
    const parsed = parseSkillMd(skillMd, name)
    if (parsed.name !== name) throw new Error('the name in the header must stay the same')
    const files = this.deps.library.files(name)
    const saved = this.deps.library.save({
      info: {
        ...info,
        description: parsed.description.slice(0, 2000),
        ...(parsed.version ? { version: parsed.version.slice(0, 60) } : {})
      },
      skillMd,
      files
    })
    const users = this.projectsUsing(name)
    if (users.length) this.deps.changed?.(users)
    return saved
  }

  remove(name: string): boolean {
    const users = this.projectsUsing(name)
    const ok = this.deps.library.remove(name)
    if (ok && users.length) this.deps.changed?.(users)
    return ok
  }

  /** Projects that have the skill attached (known through projects.json). */
  projectsUsing(name: string): string[] {
    return this.deps.library.projectsWith(name)
  }

  // ---- projects ----

  project(path: string): CodingSkillsProject {
    const attached = this.deps.library.attached(path)
    let suggestions: CodingSkillsProject['suggestions'] = []
    try {
      suggestions = suggestSkills(detectDependencies(path), this.deps.library.list(), attached)
    } catch (e) {
      this.deps.log?.(`dependency scan failed: ${(e as Error).message}`)
    }
    return { path, attached, suggestions }
  }

  attach(project: string, names: string[]): string[] {
    const before = this.deps.library.attached(project)
    const after = this.deps.library.attach(project, names)
    if (after.join() !== before.join()) this.deps.changed?.([project])
    return after
  }

  detach(project: string, name: string): string[] {
    const before = this.deps.library.attached(project)
    const after = this.deps.library.detach(project, name)
    if (after.join() !== before.join()) this.deps.changed?.([project])
    return after
  }
}
