// robots.txt (RFC 9309) for server-side page reads (tutorial importer, web reading, news
// feeds): a page is fetched only when the site allows it for Lumen (or for every agent).
// Longest match wins, Allow wins a tie; `*` and a trailing `$` work as in the RFC. No Electron.

export const USER_AGENT_TOKEN = 'lumen'

interface Rule {
  allow: boolean
  pattern: string
}

/** The rules for `agent` (its own group, else the `*` group); [] = everything allowed. */
export function parseRobots(text: string, agent = USER_AGENT_TOKEN): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = []
  let cur: { agents: string[]; rules: Rule[] } | null = null
  let lastWasAgent = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      cur.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur || (key !== 'allow' && key !== 'disallow')) continue
    if (key === 'disallow' && !value) continue
    cur.rules.push({ allow: key === 'allow', pattern: value })
  }
  const a = agent.toLowerCase()
  const own = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)))
  const pick = own.length ? own : groups.filter((g) => g.agents.includes('*'))
  return pick.flatMap((g) => g.rules)
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const re = body
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path)
}

/** Whether `path` (with its query) may be fetched under `rules`. */
export function robotsAllow(rules: Rule[], path: string): boolean {
  let best: Rule | null = null
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow)
    )
      best = r
  }
  return !best || best.allow
}
