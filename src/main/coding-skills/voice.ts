// Coding-skill voice commands → replies. Slow work (reading docs, importing, the model) runs
// after the reply ("Reading the better-auth docs…") and ends in a notice plus the review card
// in Settings → Claude Code. Electron-free: the live state comes in through ports.
import type { CodingSkillDraft, CodingSkillInfo } from '@shared/coding-skills'
import { catalogFor } from './detect'
import { matchCodingSkillIntent, projectWords, type CodingSkillIntent } from './intents'
import type { CodingSkills } from './service'
import { claimsReview, setDraftSource } from '../query/drafts'

/** A draft older than this is not what a bare "save it" means. */
export const DRAFT_VOICE_MS = 10 * 60_000

export interface VoicePorts {
  skills: CodingSkills
  /** The focused Claude session's project, if any. */
  focusedProject(): { path: string; name: string } | null
  /** A spoken project name → the project. */
  matchProject(spoken: string): { path: string; name: string } | null
  /** Sessions that will reload for these projects (names, for the reply). */
  reloadNote(projects: string[]): string
  /** A finished background step: spoken / shown as a notice. */
  notify(text: string, urgent?: boolean): void
  /** Shows the review card (Settings → Claude Code). */
  showDraft(d: CodingSkillDraft): void
  now(): number
  log(msg: string): void
}

export type VoiceReply = { mode: 'answer'; text: string; spoken: string }

function reply(text: string): VoiceReply {
  return { mode: 'answer', text, spoken: text }
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.js\b/g, 'js')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** A spoken skill name → a library skill (name, title, catalog alias). */
export function findSkill(spoken: string, list: CodingSkillInfo[]): CodingSkillInfo | null {
  const s = norm(spoken.replace(/\s+(?:coding|claude)$/i, ''))
  if (!s) return null
  const direct = list.find((x) => norm(x.name) === s || norm(x.title) === s)
  if (direct) return direct
  const c = catalogFor(spoken)
  return (c && list.find((x) => x.name === c.name)) || null
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function draftSummary(d: CodingSkillDraft): string {
  const what = d.update
    ? d.update.changed
      ? `The ${d.title} skill has changes.`
      : `The ${d.title} skill is already up to date.`
    : `The ${d.title} skill is ready.`
  const warn = d.warnings.length ? ` Check it first: it ${d.warnings[0].split(':')[0]}.` : ''
  const next =
    d.update && !d.update.changed
      ? ' Say “discard it”.'
      : ' Review it in Settings, or say “save it”, “read it back” or “discard it”.'
  return `${what}${warn}${next}`
}

function spokenSkill(d: CodingSkillDraft): string {
  const body = d.skillMd.replace(/^---[\s\S]*?\n---\n/, '')
  return body
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700)
}

export class CodingSkillVoice {
  constructor(private readonly p: VoicePorts) {
    setDraftSource('coding-skill', () => this.freshDraft()?.createdAt ?? null)
  }

  private target(name?: string): { path: string; name: string } | null {
    return name ? this.p.matchProject(name) : this.p.focusedProject()
  }

  private noProject(name?: string): VoiceReply {
    return reply(
      name
        ? `I don’t know a project called “${name}”.`
        : 'Which project? Open it in Claude first, or say the project name, like “for lumen”.'
    )
  }

  /** Runs slow work after the reply; the result becomes a notice and the review card. */
  private background(label: string, work: () => Promise<CodingSkillDraft>): void {
    void work().then(
      (d) => {
        this.p.showDraft(d)
        this.p.notify(draftSummary(d))
      },
      (e: Error) => {
        this.p.log(`${label}: ${e.message}`)
        this.p.notify(`I couldn’t make the skill: ${e.message}.`, true)
      }
    )
  }

  private freshDraft(): CodingSkillDraft | null {
    const d = this.p.skills.currentDraft()
    return d && this.p.now() - d.createdAt <= DRAFT_VOICE_MS ? d : null
  }

  handle(i: CodingSkillIntent): VoiceReply | undefined {
    const s = this.p.skills
    switch (i.kind) {
      case 'draft': {
        const d = this.freshDraft()
        // Only the newest waiting draft takes review words; a bare "forget it" while work
        // runs cancels that work (query/drafts).
        if (!d || !claimsReview('coding-skill', d.createdAt, i)) return undefined
        if (i.cmd === 'discard') {
          s.discard()
          return reply('Discarded the skill.')
        }
        if (i.cmd === 'read') return reply(spokenSkill(d))
        if (i.cmd === 'diff')
          return reply(
            d.update?.changed
              ? `Changed lines: ${d.update.diff.split('\n').filter((l) => /^[+-] /.test(l)).length}. The changes are in Settings → Claude Code.`
              : 'Nothing changed.'
          )
        if (d.update && !d.update.changed) {
          s.discard()
          return reply(`The ${d.title} skill was already up to date.`)
        }
        const info = s.save(d.id)
        const users = s.projectsUsing(info.name)
        const note = users.length ? ` ${this.p.reloadNote(users)}` : ''
        return reply(`Saved the ${info.title} skill.${note}`)
      }
      case 'add-docs': {
        const entry = catalogFor(i.topic)
        // "add a skill for X" without a link or "coding" is only ours for known libraries.
        if (!i.explicit && !entry) return undefined
        if (!i.url && !entry)
          return reply(
            `Tell me where the ${i.topic} docs are: “add a skill for ${i.topic} from https://…”.`
          )
        const project = this.p.focusedProject()
        const title = entry?.title ?? i.topic
        this.background('docs skill', () =>
          s.fromDocs({ url: i.url, title, ...(project ? { attachTo: project.path } : {}) })
        )
        return reply(
          `Reading the ${title} docs to write a skill. I’ll tell you when it’s ready to review.`
        )
      }
      case 'import': {
        const project = this.p.focusedProject()
        this.background('import skill', () =>
          s.fromImport(i.from, i.pick, undefined, project?.path)
        )
        return reply('Importing the skill. I’ll tell you when it’s ready to review.')
      }
      case 'write': {
        const project = this.p.focusedProject()
        this.background('write skill', () => s.fromText(i.title, i.text, undefined, project?.path))
        return reply(`Writing the ${i.title} skill. I’ll tell you when it’s ready to review.`)
      }
      case 'use': {
        const where = projectWords(i.project)
        // "use the X skill with <something that is not a project>" is not ours.
        const proj = this.target(where)
        if (!proj) return where ? undefined : this.noProject()
        const lib = s.library.list()
        const found: CodingSkillInfo[] = []
        const missing: string[] = []
        for (const n of i.names) {
          const hit = findSkill(n, lib)
          if (hit) found.push(hit)
          else missing.push(n)
        }
        if (!found.length && !missing.some((n) => catalogFor(n))) return undefined
        if (found.length)
          s.attach(
            proj.path,
            found.map((f) => f.name)
          )
        const parts: string[] = []
        if (found.length)
          parts.push(
            `Claude will use the ${joinNames(found.map((f) => f.title))} skill${found.length > 1 ? 's' : ''} in ${proj.name}. ${this.p.reloadNote([proj.path])}`.trim()
          )
        if (missing.length)
          parts.push(
            `I have no skill for ${joinNames(missing)} yet. Say “add a skill for ${missing[0]}”${catalogFor(missing[0]) ? '' : ' with its docs link'}.`
          )
        return reply(parts.join(' '))
      }
      case 'drop': {
        const proj = this.target(i.project)
        const lib = s.library.list()
        const hit = findSkill(i.name, lib)
        if (!hit) return i.explicit ? reply(`There’s no coding skill called ${i.name}.`) : undefined
        if (!proj) return this.noProject(i.project)
        if (!s.library.attached(proj.path).includes(hit.name))
          return reply(`${proj.name} doesn’t use the ${hit.title} skill.`)
        s.detach(proj.path, hit.name)
        return reply(
          `Dropped the ${hit.title} skill from ${proj.name}. ${this.p.reloadNote([proj.path])}`.trim()
        )
      }
      case 'save-to-project': {
        // Only on this explicit request does Lumen write into the project (.claude/skills).
        const hit = findSkill(i.name, s.library.list())
        if (!hit) return reply(`There’s no coding skill called ${i.name}.`)
        const proj = this.target()
        if (!proj) return this.noProject()
        const dest = s.library.saveToProject(proj.path, hit.name)
        return reply(`Saved the ${hit.title} skill into ${proj.name} at ${dest}.`)
      }
      case 'list': {
        const proj = this.target(i.project)
        if (!proj) return this.noProject(i.project)
        const lib = s.library.list()
        const names = s.library
          .attached(proj.path)
          .map((n) => lib.find((x) => x.name === n)?.title ?? n)
        return reply(
          names.length
            ? `Claude uses ${names.length === 1 ? 'one skill' : `${names.length} skills`} in ${proj.name}: ${joinNames(names)}.`
            : `Claude uses no coding skills from Lumen in ${proj.name}. Say “suggest skills” to see what fits.`
        )
      }
      case 'suggest': {
        const proj = this.target(i.project)
        if (!proj) return this.noProject(i.project)
        const sug = s.project(proj.path).suggestions
        if (!sug.length) return reply(`I have no skill suggestions for ${proj.name}.`)
        const have = sug.filter((x) => x.inLibrary)
        const add = sug.filter((x) => !x.inLibrary)
        const parts: string[] = []
        if (have.length)
          parts.push(
            `You have skills for ${joinNames(have.map((x) => x.title))}: say “use the ${have[0].title} skill for this project”.`
          )
        if (add.length)
          parts.push(
            `${proj.name} uses ${joinNames(add.slice(0, 4).map((x) => x.title))}: say “add a skill for ${add[0].title}”.`
          )
        return reply(parts.join(' '))
      }
      case 'update': {
        const hit = findSkill(i.name, s.library.list())
        if (!hit) return i.explicit ? reply(`There’s no coding skill called ${i.name}.`) : undefined
        if (hit.source.kind === 'written')
          return reply(
            `You wrote the ${hit.title} skill yourself; edit it in Settings → Claude Code.`
          )
        this.background('update skill', () => s.update(hit.name))
        const what = hit.source.kind === 'docs' ? 'docs' : 'source'
        return reply(`Checking the ${hit.title} ${what} again. I’ll show you what changed.`)
      }
    }
  }

  intercept(text: string): VoiceReply | undefined {
    const i = matchCodingSkillIntent(text)
    if (!i) return undefined
    try {
      return this.handle(i)
    } catch (e) {
      return reply((e as Error).message)
    }
  }
}
