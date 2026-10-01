// Per-user skill switches, kept beside the skills (not in config.json): which skills are
// switched off, and which community skills the user chose to trust. Unknown names are kept so
// a skill that is briefly missing (being edited, reinstalled) keeps its setting. No Electron.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { SKILL_NAME_RE } from './manifest'

export interface SkillState {
  disabled: string[]
  trusted: string[]
}

const clean = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && SKILL_NAME_RE.test(x)))]
        .sort()
        .slice(0, 1000)
    : []

export class SkillStateStore {
  private state: SkillState = { disabled: [], trusted: [] }

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillState>
      this.state = { disabled: clean(raw.disabled), trusted: clean(raw.trusted) }
    } catch {
      // Missing or broken: start fresh.
    }
  }

  get(): SkillState {
    return { disabled: [...this.state.disabled], trusted: [...this.state.trusted] }
  }

  isDisabled(name: string): boolean {
    return this.state.disabled.includes(name)
  }

  isTrusted(name: string): boolean {
    return this.state.trusted.includes(name)
  }

  setEnabled(name: string, enabled: boolean): void {
    this.state.disabled = toggle(this.state.disabled, name, !enabled)
    this.save()
  }

  setTrusted(name: string, trusted: boolean): void {
    this.state.trusted = toggle(this.state.trusted, name, trusted)
    this.save()
  }

  /** Drops every setting for a deleted skill. */
  forget(name: string): void {
    this.state.disabled = toggle(this.state.disabled, name, false)
    this.state.trusted = toggle(this.state.trusted, name, false)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
  }
}

function toggle(list: string[], name: string, on: boolean): string[] {
  const rest = list.filter((x) => x !== name)
  return on ? [...rest, name].sort() : rest
}
