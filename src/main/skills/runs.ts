// Run history per skill (11 T04): the last runs of each skill for Settings → Skills, kept in
// ~/.ai-overlay/skills-runs.json beside the skill switches. Summaries only: no typed text, no
// screen content. No Electron.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { SkillRunRecord } from '@shared/types'
import { SKILL_NAME_RE } from './manifest'

export const RUNS_PER_SKILL = 20
const MAX_SKILLS = 300
const HOWS = new Set(['steps', 'agent', 'steps+agent', 'background'])
const STATUSES = new Set(['done', 'failed', 'stopped', 'denied', 'cancelled', 'paused'])

function valid(r: unknown): r is SkillRunRecord {
  const x = r as SkillRunRecord
  return (
    !!x &&
    typeof x.at === 'number' &&
    typeof x.ms === 'number' &&
    HOWS.has(x.how) &&
    STATUSES.has(x.status) &&
    typeof x.summary === 'string' &&
    typeof x.actions === 'number'
  )
}

export class SkillRunLog {
  private runs: Record<string, SkillRunRecord[]> = {}

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [name, list] of Object.entries(raw)) {
        if (!SKILL_NAME_RE.test(name) || !Array.isArray(list)) continue
        this.runs[name] = list.filter(valid).slice(0, RUNS_PER_SKILL)
      }
    } catch {
      // Missing or broken: start empty.
    }
  }

  /** Newest first. */
  list(name: string): SkillRunRecord[] {
    return [...(this.runs[name] ?? [])]
  }

  add(name: string, run: SkillRunRecord): void {
    if (!SKILL_NAME_RE.test(name)) return
    const rec: SkillRunRecord = { ...run, summary: run.summary.replace(/\s+/g, ' ').slice(0, 300) }
    this.runs[name] = [rec, ...(this.runs[name] ?? [])].slice(0, RUNS_PER_SKILL)
    const names = Object.keys(this.runs)
    if (names.length > MAX_SKILLS) {
      // Drop the skills that ran longest ago.
      const oldest = names
        .map((n) => [n, this.runs[n][0]?.at ?? 0] as const)
        .sort((a, b) => a[1] - b[1])
        .slice(0, names.length - MAX_SKILLS)
      for (const [n] of oldest) delete this.runs[n]
    }
    this.save()
  }

  forget(name: string): void {
    if (!(name in this.runs)) return
    delete this.runs[name]
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.runs)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[skills] run history not saved:', (e as Error).message)
    }
  }
}
