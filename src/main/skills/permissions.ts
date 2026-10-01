// A skill's declared permissions (CONTRACTS C10) enforced on its foreground run (11 T04): every
// tool call and every deterministic step is checked here before the safety policy sees it.
// input → click / type / keys, only in the skill's `apps` when it lists any; network → which
// URLs navigate may open; profile → memory search; connectors → which MCP servers' tools;
// tools → the skill's own tool list. Anything
// else is E_DENIED with a spoken reason. risky skills and untrusted community skills confirm
// every action. Pure.
import type { SkillManifest, SkillTrust } from '@shared/types'

export type SkillCall =
  /** act / keys / a deterministic click, type or key step. */
  | { kind: 'input'; tool: string; app: string | null }
  | { kind: 'launch'; tool: string; app: string }
  | { kind: 'navigate'; tool: string; url: string }
  /** memory_search (profile fields). */
  | { kind: 'profile'; tool: string }
  /** A connector (MCP) tool, `mcp__<server>__<tool>`. */
  | { kind: 'connector'; tool: string; server: string }
  /** Anything else (observe, wait_for, ask_user, skill tools …). */
  | { kind: 'tool'; tool: string }

export type SkillVerdict =
  | { ok: true; confirm: boolean }
  | { ok: false; reason: string; spoken: string }

/** Tools a skill may always call: they read, ask or end, and touch nothing. */
const ALWAYS = new Set(['finish', 'observe', 'wait_for', 'ask_user', 'read_file'])
const SKILL_TOOLS = new Set(['use_skill', 'read_skill_file', 'list_skills'])

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** "davinci-resolve" matches the app id "davinci-resolve", "Resolve.exe" and "DaVinci Resolve". */
export function appAllowed(apps: readonly string[], app: string | null): boolean {
  if (!apps.length) return true
  if (!app) return false
  const a = alnum(app.replace(/\.exe$/i, ''))
  if (!a) return false
  return apps.some((x) => {
    const want = alnum(x)
    return (
      want === a || (a.length >= 4 && want.includes(a)) || (want.length >= 4 && a.includes(want))
    )
  })
}

/** "https://*.youtube.com" allows https://www.youtube.com/… and https://youtube.com/…. */
export function urlAllowed(patterns: readonly string[], url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return patterns.some((p) => {
    const m = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(p.trim())
    if (!m || `${m[1].toLowerCase()}:` !== u.protocol) return false
    const host = m[2].toLowerCase()
    const hostOk = host.startsWith('*.')
      ? u.host === host.slice(2) || u.host.endsWith(host.slice(1))
      : u.host === host
    if (!hostOk) return false
    if (!m[3] || m[3] === '/' || m[3] === '/*') return true
    const path = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${path}$`).test(u.pathname)
  })
}

/** The skill asks before every action (risky, or a community skill the user has not trusted). */
export function confirmsEveryAction(m: SkillManifest, trust: SkillTrust): boolean {
  return m.permissions.risky || trust === 'community-untrusted'
}

function deny(m: SkillManifest, what: string): SkillVerdict {
  return {
    ok: false,
    reason: `E_DENIED: the skill "${m.name}" is not allowed to ${what}. Do not retry this; say so in finish.`,
    spoken: `The ${m.name.replace(/-/g, ' ')} skill is not allowed to ${what}, so I blocked that.`
  }
}

/** Whether the skill may make this call, and whether it must ask first. */
export function checkSkillCall(m: SkillManifest, trust: SkillTrust, call: SkillCall): SkillVerdict {
  const p = m.permissions
  if (call.kind === 'connector')
    return p.connectors.includes(call.server)
      ? { ok: true, confirm: confirmsEveryAction(m, trust) }
      : deny(m, `use the ${call.server} connector`)
  if (
    m.tools &&
    !ALWAYS.has(call.tool) &&
    !SKILL_TOOLS.has(call.tool) &&
    !m.tools.includes(call.tool)
  )
    return deny(m, `use the ${call.tool.replace(/_/g, ' ')} tool`)
  const confirm = confirmsEveryAction(m, trust)
  switch (call.kind) {
    case 'tool':
      return { ok: true, confirm: false }
    case 'profile':
      return p.profile ? { ok: true, confirm: false } : deny(m, 'read your saved profile')
    case 'input':
      if (!p.input) return deny(m, 'use the mouse and keyboard')
      if (!appAllowed(m.apps, call.app))
        return deny(
          m,
          `use the mouse and keyboard in ${call.app ? appLabel(call.app) : 'this window'} (only in ${m.apps.join(', ')})`
        )
      return { ok: true, confirm }
    case 'launch':
      if (!p.input) return deny(m, 'start apps')
      if (!appAllowed(m.apps, call.app)) return deny(m, `start ${call.app}`)
      return { ok: true, confirm }
    case 'navigate':
      if (!p.input) return deny(m, 'use the browser')
      if (!urlAllowed(p.network, call.url))
        return deny(
          m,
          `open ${hostOf(call.url)}${p.network.length ? '' : ' (it may not open web pages)'}`
        )
      return { ok: true, confirm }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 60)
  } catch {
    return url.slice(0, 60)
  }
}

const appLabel = (app: string): string => app.replace(/\.exe$/i, '')

/** The call a tool use is, for the check. `app` is the foreground app id or process name. */
export function classifyToolCall(
  tool: string,
  input: Record<string, unknown>,
  app: string | null
): SkillCall {
  switch (tool) {
    case 'act':
    case 'keys':
      return { kind: 'input', tool, app }
    case 'launch_app':
      return { kind: 'launch', tool, app: String(input.app ?? '') }
    case 'navigate':
      return { kind: 'navigate', tool, url: String(input.url ?? '') }
    case 'memory_search':
      return { kind: 'profile', tool }
    default: {
      const server = mcpServerOf(tool)
      return server ? { kind: 'connector', tool, server } : { kind: 'tool', tool }
    }
  }
}

/** "mcp__github__search" → "github"; null for other tools. */
export function mcpServerOf(tool: string): string | null {
  const m = /^mcp__([a-z0-9-]+)__/.exec(tool)
  return m ? m[1] : null
}

/** Tools that need the foreground app for the check. */
export const APP_CHECKED_TOOLS: readonly string[] = ['act', 'keys']

/** The agent tool a deterministic step stands for (the skill's `tools` list names tools). */
export function stepTool(step: { do: string }): string {
  if (step.do === 'keys') return 'keys'
  if (step.do === 'navigate') return 'navigate'
  if (step.do === 'wait') return 'wait_for'
  return 'act'
}
