// Commands discovery + voice mapping (08 T37): slash commands and skills of a project, the
// user's own (~/.claude), installed plugins and the session's init list, so "run the code
// review" becomes "/code-review". Commands are sent as user turns.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join, relative } from 'path'
import { claudeHome } from './projects'

export interface ClaudeCommand {
  name: string
  source: 'project' | 'user' | 'plugin' | 'session'
  description?: string
}

const MAX_FILES = 400
const MAX_DEPTH = 4

function description(file: string): string | undefined {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4000)
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
    const m = fm && /^description:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
    return m ? m[1].slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

function frontName(file: string): string | undefined {
  try {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8').slice(0, 4000))
    const m = fm && /^name:\s*["']?([\w:.-]+)["']?\s*$/m.exec(fm[1])
    return m?.[1]
  } catch {
    return undefined
  }
}

function mdFiles(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES || !existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      if (statSync(p).isDirectory()) mdFiles(p, depth + 1, acc)
      else if (name.endsWith('.md')) acc.push(p)
    } catch {
      /* unreadable entry */
    }
  }
  return acc
}

/** .claude-style root: commands/*.md and skills/<name>/SKILL.md. */
export function commandsIn(
  root: string,
  source: ClaudeCommand['source'],
  prefix = ''
): ClaudeCommand[] {
  const out: ClaudeCommand[] = []
  const cmdDir = join(root, 'commands')
  for (const f of mdFiles(cmdDir)) {
    const rel = relative(cmdDir, f).replace(/\.md$/i, '')
    out.push({ name: prefix + basename(rel), source, description: description(f) })
  }
  const skillDir = join(root, 'skills')
  if (existsSync(skillDir))
    for (const name of readdirSync(skillDir)) {
      const f = join(skillDir, name, 'SKILL.md')
      if (!existsSync(f)) continue
      out.push({ name: prefix + (frontName(f) ?? name), source, description: description(f) })
    }
  return out
}

function pluginRoots(home: string): { root: string; name: string }[] {
  const file = join(home, 'plugins', 'installed_plugins.json')
  if (!existsSync(file)) return []
  const roots: { root: string; name: string }[] = []
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key))
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === 'installPath' && typeof x === 'string')
          roots.push({ root: x, name: key.split('@')[0] })
        else walk(x, k.includes('@') ? k : key)
      }
  }
  try {
    walk(JSON.parse(readFileSync(file, 'utf8')), '')
  } catch {
    return []
  }
  return roots.filter((r) => r.name && existsSync(r.root))
}

/** Every command for a project; the session's init list fills in built-ins. */
export function discoverCommands(
  project: string,
  sessionList: string[] = [],
  home = claudeHome()
): ClaudeCommand[] {
  const all = [
    ...commandsIn(join(project, '.claude'), 'project'),
    ...commandsIn(home, 'user'),
    ...pluginRoots(home).flatMap((p) => commandsIn(p.root, 'plugin', `${p.name}:`)),
    ...sessionList.map((name) => ({ name: name.replace(/^\//, ''), source: 'session' as const }))
  ]
  const seen = new Set<string>()
  return all.filter((c) => {
    const k = c.name.toLowerCase()
    if (!c.name || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---- voice mapping ----

const FILLER_RE =
  /\b(please|run|do|start|use|launch|execute|the|a|an|my|command|skill|slash|claude|for me|now)\b/g

const ALIASES: Record<string, string> = {
  review: 'code-review',
  'code review': 'code-review',
  'review the code': 'code-review',
  'clean up': 'simplify',
  simplify: 'simplify',
  'security review': 'security-review',
  compact: 'compact',
  init: 'init'
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** "run the code review" → the command, or null (a plain instruction then). */
export function matchCommand(spoken: string, commands: ClaudeCommand[]): ClaudeCommand | null {
  const said = norm(spoken).replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim()
  if (!said) return null
  const byName = (n: string): ClaudeCommand | undefined =>
    commands.find((c) => c.name.toLowerCase() === n.toLowerCase())
  const alias = ALIASES[said]
  if (alias && byName(alias)) return byName(alias)!
  const saidJoined = said.replace(/\s/g, '')
  for (const c of commands) {
    const n = norm(c.name)
    if (n === said || n.replace(/\s/g, '') === saidJoined) return c
  }
  // "caveman commit" for "caveman:caveman-commit": every spoken word in the name.
  const words = said.split(' ')
  const hits = commands.filter((c) => {
    const n = norm(c.name).split(' ')
    return words.every((w) => n.includes(w))
  })
  return hits.length === 1
    ? hits[0]
    : (hits.sort((a, b) => a.name.length - b.name.length)[0] ?? null)
}
