// Plain words for the Privacy section's grants list and action log (08 T03/T04). Pure, so the
// wording is tested without a renderer.
import type { AgentGrant, AuditLine } from '@shared/channels'

/** "app:outlook.exe" → "Outlook (app)"; "domain:github.com" → "github.com (site)". */
export function grantLabel(scope: AgentGrant['scope']): string {
  const i = scope.indexOf(':')
  const kind = scope.slice(0, i)
  const rest = scope.slice(i + 1)
  if (kind === 'app') {
    const base = rest.replace(/\.exe$/i, '')
    return `${base.charAt(0).toUpperCase()}${base.slice(1)} (app)`
  }
  if (kind === 'domain') return `${rest} (site)`
  if (kind === 'scheme') return `${rest} links`
  if (kind === 'mcp') {
    const [server, tool] = rest.split('/')
    return tool ? `${tool} on ${server} (connector)` : `${server} (connector)`
  }
  return scope
}

type Typed = { len?: number; redacted?: string } | undefined

/** One action in plain words: "Typed 12 characters", "Pressed ctrl+s", "Opened https://…". */
export function auditWhat(a: AuditLine['action']): string {
  const type = String(a.type ?? 'action')
  if (type === 'type') {
    const t = a.text as Typed
    return t?.redacted !== undefined ? `Typed “${t.redacted}”` : `Typed ${t?.len ?? 0} characters`
  }
  if (type === 'hotkey' && a.keys) return `Pressed ${String(a.keys)}`
  if (a.url) return `Opened ${String(a.url)}`
  if (a.tool) return `Used ${String(a.tool)}`
  const verb = type.replace(/_/g, ' ')
  const nice = verb.charAt(0).toUpperCase() + verb.slice(1)
  return a.element ? `${nice} “${String(a.element)}”` : nice
}

const DECISIONS: Record<string, string> = {
  auto: 'Allowed',
  granted: 'Allowed (always)',
  preapproved: 'You OK’d it',
  'confirmed-by-user': 'You said yes',
  'always-by-user': 'You said always',
  'denied-by-user': 'You said no',
  blocked: 'Blocked'
}

/** Who decided and how it went: "You said yes", "Blocked: never types into a terminal". */
export function auditOutcome(l: AuditLine): string {
  const decided = DECISIONS[l.decision] ?? l.decision
  if (l.result === 'denied') return l.reason ? `${decided}: ${l.reason}` : decided
  if (l.result === 'ok') return decided
  return `${decided}, ${l.result === 'error' ? 'failed' : 'cancelled'}`
}

const ORIGINS: Record<AuditLine['origin'], string> = {
  'user-direct': 'You asked',
  agent: 'Agent task',
  lesson: 'Lesson',
  routine: 'Routine',
  mcp: 'Connector'
}

export function auditOrigin(o: AuditLine['origin']): string {
  return ORIGINS[o] ?? o
}

const DAY_MS = 86_400_000

/** The audit day file (UTC YYYY-MM-DD, as the log names them) `offset` days from `from`. */
export function dayKey(from: Date, offset = 0): string {
  return new Date(from.getTime() + offset * DAY_MS).toISOString().slice(0, 10)
}
