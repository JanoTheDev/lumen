// Skills inside background tasks: the shared skill tools (use_skill offers only skills that
// need no mouse and keyboard), and, for a task that runs a named skill, that skill's grants:
// its read folders, its network patterns, its model, and its instructions preloaded in the
// first turn (its on-screen steps go through request_foreground).
// Permissions = skill permissions ∩ background tool set ∩ user grants.
import type { Role } from '../../ai/models'
import { enabledSkill, preloadSkill, skillToolSet, type SkillToolSet } from '../skill-tools'

export interface BackgroundSkills extends SkillToolSet {
  /** The named skill's grants (only when the task runs a skill). */
  skill?: {
    name: string
    readRoots: string[]
    network: string[]
    role?: Role
    /** use_skill output, preloaded as the task's instructions. */
    text?: string
  }
  /** Why the named skill cannot run (not installed or switched off). */
  missing?: string
}

/** "https://*.youtube.com" → matches https://www.youtube.com/... and https://youtube.com/... */
export function networkAllows(patterns: readonly string[], url: string): boolean {
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
      ? u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1))
      : u.hostname === host
    if (!hostOk) return false
    if (!m[3] || m[3] === '/' || m[3] === '/*') return true
    const path = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${path}$`).test(u.pathname)
  })
}

export function backgroundSkills(
  skillName?: string,
  onUse?: (name: string) => void
): BackgroundSkills {
  const tools = skillToolSet({
    // A background task cannot click or type: skills that need input stay foreground.
    allow: (s) => !s.manifest.permissions.input && !!enabledSkill(s.manifest.name),
    ...(onUse ? { onUse: (s) => onUse(s.manifest.name) } : {})
  })
  if (!skillName) return tools
  const s = enabledSkill(skillName)
  if (!s) return { ...tools, missing: `The skill "${skillName}" is not installed or is off.` }
  const m = s.manifest
  const text = preloadSkill(m.name)?.text
  return {
    ...tools,
    skill: {
      name: m.name,
      readRoots: m.permissions.files.read,
      network: m.permissions.network,
      ...(m.model ? { role: m.model } : {}),
      ...(text ? { text } : {})
    }
  }
}
