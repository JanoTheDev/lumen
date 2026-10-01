// Per-user skill switches, kept beside the skills (not in config.json): which skills are
// switched off, and which community skills the user chose to trust. Unknown names are kept so
// a skill that is briefly missing (being edited, reinstalled) keeps its setting. Trust is
// pinned to the installed pack (its source and archive hash, `trustPin`): a skill of the same
// name from another pack, or changed content, is not trusted until the user trusts it again.
// No Electron.
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { SKILL_NAME_RE } from './manifest'

export interface SkillState {
  disabled: string[]
  trusted: string[]
  /** Trusted skill → the pin of the pack the user trusted. */
  pins: Record<string, string>
}

const PIN_RE = /^[0-9a-f]{32}$/

/** What trust is bound to: the pack's source (file name or URL) and its archive SHA-256. */
export function trustPin(marker: { source?: string; sha256?: string }): string {
  return createHash('sha256')
    .update(`${marker.source ?? ''}\n${marker.sha256 ?? ''}`)
    .digest('hex')
    .slice(0, 32)
}

const clean = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && SKILL_NAME_RE.test(x)))]
        .sort()
        .slice(0, 1000)
    : []

const cleanPins = (v: unknown, names: string[]): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, p] of Object.entries(v as Record<string, unknown>))
    if (names.includes(k) && typeof p === 'string' && PIN_RE.test(p)) out[k] = p
  return out
}

export class SkillStateStore {
  private state: SkillState = { disabled: [], trusted: [], pins: {} }

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillState>
      const trusted = clean(raw.trusted)
      this.state = { disabled: clean(raw.disabled), trusted, pins: cleanPins(raw.pins, trusted) }
    } catch {
      // Missing or broken: start fresh.
    }
  }

  get(): SkillState {
    return {
      disabled: [...this.state.disabled],
      trusted: [...this.state.trusted],
      pins: { ...this.state.pins }
    }
  }

  isDisabled(name: string): boolean {
    return this.state.disabled.includes(name)
  }

  /**
   * Trusted, and (with `pin`) trusted for that exact pack. Trust saved before pins existed is
   * bound to the pack that is installed when it is first checked (the registry checks every
   * skill on load, before any install can replace one).
   */
  isTrusted(name: string, pin?: string): boolean {
    if (!this.state.trusted.includes(name)) return false
    if (pin === undefined) return true
    const bound = this.state.pins[name]
    if (bound === undefined) {
      this.state.pins = { ...this.state.pins, [name]: pin }
      this.save()
      return true
    }
    return bound === pin
  }

  setEnabled(name: string, enabled: boolean): void {
    this.state.disabled = toggle(this.state.disabled, name, !enabled)
    this.save()
  }

  setTrusted(name: string, trusted: boolean, pin?: string): void {
    this.state.trusted = toggle(this.state.trusted, name, trusted)
    const rest = Object.fromEntries(Object.entries(this.state.pins).filter(([k]) => k !== name))
    this.state.pins = trusted && pin && PIN_RE.test(pin) ? { ...rest, [name]: pin } : rest
    this.save()
  }

  /** Drops every setting for a deleted skill. */
  forget(name: string): void {
    this.state.disabled = toggle(this.state.disabled, name, false)
    this.setTrusted(name, false)
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
