// Plain-language text for Settings → Skills (11 T05/T06): what a skill may do, its trust level,
// the search filter and run history lines. Pure, shared by the list and the install screen.
import type { SkillPermissions, SkillRunRecord, SkillSummary, SkillTrust } from '@shared/types'

export const TRUST_LABEL: Record<SkillTrust, string> = {
  builtin: 'comes with Lumen',
  mine: 'yours',
  'community-untrusted': 'community, untrusted',
  'community-trusted': 'community, trusted'
}

/** One line per thing the skill may do; ["Only reads the screen and answers"] when nothing. */
export function permissionLines(p: SkillPermissions, apps: string[] = []): string[] {
  const out: string[] = []
  if (p.input)
    out.push(
      apps.length
        ? `Uses your mouse and keyboard in ${apps.join(', ')}`
        : 'Uses your mouse and keyboard in any app'
    )
  if (p.network.length) out.push(`Opens web pages: ${p.network.join(', ')}`)
  if (p.files.read.length) out.push(`Reads files in ${p.files.read.join(', ')}`)
  if (p.files.write.length) out.push(`Changes files in ${p.files.write.join(', ')}`)
  if (p.connectors.length) out.push(`Uses connectors: ${p.connectors.join(', ')}`)
  if (p.profile) out.push('Reads your saved profile (name, address, email)')
  if (p.screen) out.push('Looks at your screen while running in the background')
  if (!out.length) out.push('Only reads the screen and answers')
  if (p.risky) out.push('Asks before every action')
  return out
}

/** Whether a skill asks for anything beyond reading and answering. */
export function asksForMore(p: SkillPermissions): boolean {
  return (
    p.input ||
    p.profile ||
    p.screen ||
    p.network.length > 0 ||
    p.files.read.length > 0 ||
    p.files.write.length > 0 ||
    p.connectors.length > 0
  )
}

/** Skills whose name, description, triggers or apps contain every word of the query. */
export function filterSkills(list: SkillSummary[], query: string): SkillSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter((s) => {
    const hay = [
      s.name,
      s.description,
      s.when_to_use ?? '',
      ...s.triggers,
      ...s.apps,
      TRUST_LABEL[s.trust]
    ]
      .join(' ')
      .toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** The short status line under a skill's name. */
export function skillMeta(s: SkillSummary): string {
  const parts = [TRUST_LABEL[s.trust], `v${s.version}`]
  if (s.overrides)
    parts.push(`replaces the ${s.overrides === 'builtin' ? 'built-in' : 'app pack'} one`)
  if (s.context === 'background') parts.push('runs in the background')
  if (s.hasSteps) parts.push('has recorded steps')
  if (s.needsUpdate) parts.push('needs an update')
  if (s.triggers.length) parts.push(`say “${s.triggers[0]}”`)
  if (!s.enabled) parts.push('off')
  return parts.join(' · ')
}

const HOW_LABEL: Record<SkillRunRecord['how'], string> = {
  steps: 'recorded steps, no AI',
  agent: 'with the AI',
  'steps+agent': 'recorded steps, then the AI',
  background: 'in the background'
}

const STATUS_LABEL: Record<SkillRunRecord['status'], string> = {
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped at a limit',
  denied: 'Blocked',
  cancelled: 'Cancelled',
  paused: 'Paused'
}

/** One run in the history: "Done · 2 min ago · recorded steps, no AI · 4 actions · 3 s". */
export function runLine(r: SkillRunRecord, now = Date.now()): string {
  const ago = Math.max(0, Math.round((now - r.at) / 60_000))
  const when =
    ago < 1
      ? 'just now'
      : ago < 60
        ? `${ago} min ago`
        : ago < 48 * 60
          ? `${Math.round(ago / 60)} h ago`
          : new Date(r.at).toLocaleDateString()
  const secs = Math.max(1, Math.round(r.ms / 1000))
  return [
    STATUS_LABEL[r.status],
    when,
    HOW_LABEL[r.how],
    `${r.actions} ${r.actions === 1 ? 'action' : 'actions'}`,
    secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`
  ].join(' · ')
}
