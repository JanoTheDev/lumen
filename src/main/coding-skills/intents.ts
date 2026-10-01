// Voice and typed commands for coding skills. Pure; the interceptor resolves names and the
// project with the live state, and lets ambiguous ones fall through to Lumen's own skills.
export type CodingSkillIntent =
  | { kind: 'add-docs'; topic: string; url?: string; explicit: boolean; project?: string }
  | { kind: 'import'; from: string; pick?: string; project?: string }
  | { kind: 'write'; title: string; text: string; project?: string }
  | { kind: 'use'; names: string[]; project: string }
  | { kind: 'drop'; name: string; project?: string; explicit: boolean }
  | { kind: 'list'; project?: string }
  | { kind: 'suggest'; project?: string }
  | { kind: 'update'; name: string; explicit: boolean }
  | { kind: 'draft'; cmd: 'save' | 'discard' | 'read' | 'diff' }
  | { kind: 'save-to-project'; name: string }

/** "this project" / "here" / "in Claude" → undefined (the focused session's project). */
function projectRef(s: string | undefined): string | undefined {
  if (!s) return undefined
  const t = s.trim().replace(/^(?:the|my)\s+/i, '')
  if (
    /^(?:this|that|the current|current)(?: project| repo| codebase)?$|^here$|^claude(?: code)?$/i.test(
      t
    )
  )
    return undefined
  return t.replace(/\s+(?:project|repo)$/i, '') || undefined
}

/** "Next.js and better-auth" → ["Next.js", "better-auth"]. */
export function splitNames(s: string): string[] {
  return s
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+plus\s+/i)
    .map((x) => x.replace(/^(?:the|my)\s+/i, '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

const SKILL = String.raw`(?:coding |claude |claude code )?skills?`
const FOR_PROJECT = String.raw`(?:\s+(?:for|in|on|to|with)\s+(.+?))?`

function clean(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
}

export function matchCodingSkillIntent(text: string): CodingSkillIntent | null {
  const t = clean(text)
  if (!t || t.length > 20_000) return null
  let m: RegExpExecArray | null

  m =
    /^(?:write|make|create)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:coding|claude(?: code)?)\s+skill\s+(?:for|about|on|called)\s+([^:]{1,80}?)\s*[:,–-]\s+([\s\S]+)$/i.exec(
      t
    )
  if (m) return { kind: 'write', title: m[1].trim(), text: m[2].trim() }

  if (t.length > 600) return null

  m =
    /^(?:save|copy|put|write)\s+(?:the\s+)?(.+?)\s+(?:coding\s+|claude\s+)?skill\s+(?:to|into|in)\s+(?:the\s+|this\s+|my\s+)?(?:project|repo|repository)(?:'s \.?claude folder)?$/i.exec(
      t
    )
  if (m) return { kind: 'save-to-project', name: m[1].trim() }

  m = /^(?:save|keep)(?: it| that| the(?: coding| claude)? skill| this skill)?$/i.exec(t)
  if (m) return { kind: 'draft', cmd: 'save' }
  if (/^(?:discard|throw away|forget)(?: it| that| the(?: coding| claude)? skill)?$/i.test(t))
    return { kind: 'draft', cmd: 'discard' }
  if (/^(?:read (?:it|the skill)(?: back)?(?: to me)?|what does the skill say)$/i.test(t))
    return { kind: 'draft', cmd: 'read' }
  if (
    /^(?:what changed in the skill|what's new in the skill|show (?:me )?the (?:skill )?(?:diff|changes))$/i.test(
      t
    )
  )
    return { kind: 'draft', cmd: 'diff' }

  m = new RegExp(
    String.raw`^(?:add|make|create|build|get)\s+(?:me\s+)?(?:a\s+|an\s+)?(coding\s+|claude(?: code)?\s+)?skill\s+(?:for|about|on)\s+(.+?)(?:\s+(?:from|using|with)\s+(?:the\s+docs\s+(?:at\s+)?)?(https?://\S+))?(?:\s+(?:for|in)\s+(this project|here|claude(?: code)?))?$`,
    'i'
  ).exec(t)
  if (m)
    return {
      kind: 'add-docs',
      topic: m[2].replace(/^(?:the|my)\s+/i, '').trim(),
      ...(m[3] ? { url: m[3].replace(/[),.;]+$/, '') } : {}),
      explicit: !!m[1] || !!m[3] || !!m[4]
    }

  m =
    /^import\s+(?:the\s+|a\s+|an\s+)?(?:(.+?)\s+)?(?:claude\s+|coding\s+)?skill\s+(?:from|at)\s+(\S.*)$/i.exec(
      t
    )
  if (m) return { kind: 'import', from: m[2].trim(), ...(m[1] ? { pick: m[1].trim() } : {}) }

  m = new RegExp(
    String.raw`^(?:use|attach|add|enable|turn on)\s+(?:the\s+)?(.+?)\s+${SKILL}\s+(?:for|in|on|to|with)\s+(.+)$`,
    'i'
  ).exec(t)
  if (m) {
    const where = m[2].trim()
    // "use the prisma skill in Claude" / "for this project" / "for lumen".
    return { kind: 'use', names: splitNames(m[1]), project: where }
  }

  m = new RegExp(
    String.raw`^(?:(drop|detach|stop using)|remove|turn off|disable)\s+(?:the\s+)?(.+?)\s+${SKILL}${FOR_PROJECT}$`,
    'i'
  ).exec(t)
  if (m) {
    const explicit = !!m[1] || !!m[3]
    return {
      kind: 'drop',
      name: m[2].trim(),
      explicit,
      ...(projectRef(m[3]) ? { project: projectRef(m[3]) } : {})
    }
  }

  m =
    /^(?:what|which)\s+skills\s+(?:is|does|has)\s+claude(?: code)?\s+(?:using|use|got|have|loaded)(?:\s+(?:here|in|for|on)(?:\s+(.+?))?)?$/i.exec(
      t
    )
  if (m) return { kind: 'list', ...(projectRef(m[1]) ? { project: projectRef(m[1]) } : {}) }
  m =
    /^(?:list|show)(?: me)?\s+(?:the\s+)?(?:coding|claude(?: code)?)\s+skills(?:\s+(?:for|in|of)\s+(.+?))?$/i.exec(
      t
    )
  if (m) return { kind: 'list', ...(projectRef(m[1]) ? { project: projectRef(m[1]) } : {}) }

  m =
    /^(?:(?:what|which)\s+(?:coding\s+)?skills\s+should\s+(?:i|we|claude)\s+(?:add|use|get)|suggest\s+(?:some\s+)?(?:coding\s+)?skills)(?:\s+(?:here|for|in)(?:\s+(.+?))?)?$/i.exec(
      t
    )
  if (m) return { kind: 'suggest', ...(projectRef(m[1]) ? { project: projectRef(m[1]) } : {}) }

  m =
    /^(?:update|refresh|re-?fetch|re-?read)\s+(?:the\s+)?(.+?)\s+(coding\s+|claude\s+)?skill$/i.exec(
      t
    )
  if (m) return { kind: 'update', name: m[1].trim(), explicit: !!m[2] }

  return null
}

/** The project words of a `use` intent: undefined = the focused session's project. */
export function projectWords(where: string): string | undefined {
  return projectRef(where)
}
