// Claude-format SKILL.md for coding skills (code.claude.com/docs/en/skills, checked
// 2026-10-01): `name` (lowercase, digits, hyphens), `description` (what + when; with
// `when_to_use` cut at 1,536 characters in Claude's skill list), optional `when_to_use` and
// `metadata`. Rendering, reading back, review warnings and a line diff for updates. Pure.
import { CODING_SKILL_NAME_RE } from '@shared/coding-skills'
import { FrontmatterError, splitFrontmatter, type YamlValue } from '../skills/frontmatter'

export const LISTING_MAX = 1536
export const BODY_MAX = 40_000

export interface SkillMdInput {
  name: string
  description: string
  whenToUse?: string
  body: string
  /** metadata: source links and the version the skill was written for. */
  sources?: string[]
  version?: string
}

function q(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, ' ').trim())
}

/** "Better Auth" / "next.js 15" → "better-auth" / "next-js-15". */
export function skillSlug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/\.js\b/g, 'js')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return CODING_SKILL_NAME_RE.test(s) ? s : 'skill'
}

/** Description and when_to_use trimmed so both fit Claude's listing cap. */
function fit(description: string, whenToUse?: string): { d: string; w?: string } {
  const d = description.replace(/\s+/g, ' ').trim().slice(0, 1024)
  const room = LISTING_MAX - d.length - 1
  const w = whenToUse?.replace(/\s+/g, ' ').trim()
  return w && room > 40 ? { d, w: w.slice(0, room) } : { d }
}

export function renderSkillMd(s: SkillMdInput): string {
  const { d, w } = fit(s.description, s.whenToUse)
  const head = ['---', `name: ${s.name}`, `description: ${q(d)}`]
  if (w) head.push(`when_to_use: ${q(w)}`)
  const meta: string[] = []
  if (s.version) meta.push(`  version: ${q(s.version.slice(0, 60))}`)
  if (s.sources?.length) meta.push(`  sources: [${s.sources.slice(0, 10).map(q).join(', ')}]`)
  if (meta.length) head.push('metadata:', ...meta)
  head.push('---')
  return `${head.join('\n')}\n\n${neutralizeBody(s.body).body.trim().slice(0, BODY_MAX)}\n`
}

/**
 * Claude Code runs dynamic context (!`command` inline, ```! blocks) when it loads a skill.
 * Lumen-written and imported skills keep such lines as plain code (as plugins/convert does).
 */
export function neutralizeBody(body: string): { body: string; changed: boolean } {
  const out = body.replace(/(^|\s)!`([^`\n]*)`/g, '$1`$2`').replace(/^(\s*)```!\s*$/gm, '$1```')
  return { body: out, changed: out !== body }
}

/** Header keys Lumen keeps; anything else (allowed-tools, hooks, model, context …) is dropped. */
const KEPT_KEYS = new Set(['name', 'description', 'when_to_use', 'metadata'])

/**
 * An imported (or library) SKILL.md re-rendered from its name, description, when_to_use and
 * metadata only, with dynamic-context commands made plain. `notes` say what was dropped.
 * Throws like `parseSkillMd`.
 */
export function sanitizeSkillMd(
  text: string,
  fallbackName?: string
): { skillMd: string; parsed: ParsedSkillMd; notes: string[] } {
  const parsed = parseSkillMd(text, fallbackName)
  const { data } = splitFrontmatter(text)
  const dropped = Object.keys(data).filter((k) => !KEPT_KEYS.has(k))
  const notes: string[] = []
  if (dropped.length)
    notes.push(`dropped Claude Code settings from its header: ${dropped.slice(0, 10).join(', ')}`)
  if (neutralizeBody(parsed.body).changed)
    notes.push('commands it would run while loading are kept as plain text')
  const skillMd = renderSkillMd({
    name: parsed.name,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    body: parsed.body,
    sources: parsed.sources,
    version: parsed.version
  })
  return { skillMd, parsed: parseSkillMd(skillMd, fallbackName), notes }
}

export interface ParsedSkillMd {
  name: string
  description: string
  whenToUse?: string
  version?: string
  sources: string[]
  body: string
}

function str(v: YamlValue | undefined): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
}

/**
 * Reads a SKILL.md (Lumen-written or imported). `fallbackName` is the folder name, used when
 * the header has none (Claude's rule). Throws with a readable reason.
 */
export function parseSkillMd(text: string, fallbackName?: string): ParsedSkillMd {
  let data: Record<string, YamlValue>
  let body: string
  try {
    ;({ data, body } = splitFrontmatter(text))
  } catch (e) {
    throw new Error(
      e instanceof FrontmatterError ? `SKILL.md: ${e.message}` : 'SKILL.md could not be read'
    )
  }
  const name = (str(data.name) ?? fallbackName ?? '').trim().toLowerCase()
  if (!CODING_SKILL_NAME_RE.test(name))
    throw new Error('the skill name must be lowercase letters, digits and hyphens (max 64)')
  const description =
    str(data.description)?.trim() ||
    body
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ||
    ''
  if (!description) throw new Error('the skill has no description')
  if (!body.trim()) throw new Error('the skill has no instructions')
  if (text.length > BODY_MAX + 4000) throw new Error('the skill is too long')
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {}
  const m = meta as Record<string, YamlValue>
  const sources = Array.isArray(m.sources) ? m.sources.map(String).slice(0, 10) : []
  return {
    name,
    description,
    ...(str(data.when_to_use) ? { whenToUse: str(data.when_to_use) } : {}),
    ...(str(m.version) ? { version: str(m.version) } : {}),
    sources,
    body
  }
}

const WARN_RULES: [RegExp, string][] = [
  [
    /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sh|bash|zsh|iex|powershell|pwsh)\b/i,
    'pipes a download into a shell'
  ],
  [/\brm\s+-rf?\b|\bremove-item\b[^\n]*-recurse|\bdel\s+\/s\b/i, 'deletes files'],
  [/\bgit\s+push\b[^\n]*(?:--force|-f\b)|\bgit\s+reset\s+--hard\b/i, 'rewrites git history'],
  [
    /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|rules)/i,
    'tells Claude to ignore its instructions'
  ],
  [
    /\b(?:disregard|override) (?:the |your )?(?:system|user|safety)\b/i,
    'tells Claude to override its rules'
  ],
  [
    /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i,
    'contains what looks like a secret'
  ],
  [
    /\b(?:send|post|upload)\b[^\n]{0,60}\b(?:\.env|credentials|ssh key|private key|api key)/i,
    'sends secrets somewhere'
  ],
  [/--dangerously-skip-permissions|bypassPermissions/i, 'turns off Claude Code permissions'],
  [
    /^\s*(?:allowed-tools|disallowed-tools|hooks)\s*:/,
    'sets Claude Code tool permissions or hooks'
  ],
  [/(^|\s)!`|^\s*```!\s*$/, 'runs a command when Claude loads it'],
  [/\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, 'publishes a package']
]

/** Lines of a skill the user should read before saving it (docs and imports are untrusted). */
export function reviewWarnings(skillMd: string, sourceHosts: string[] = []): string[] {
  const out: string[] = []
  const lines = skillMd.split('\n')
  for (const [re, why] of WARN_RULES) {
    const line = lines.find((l) => re.test(l))
    if (line) out.push(`${why}: ${line.trim().slice(0, 160)}`)
  }
  if (sourceHosts.length) {
    const hosts = new Set(sourceHosts.map((h) => h.toLowerCase().replace(/^www\./, '')))
    const odd = new Set<string>()
    for (const m of skillMd.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const h = m[1].toLowerCase().replace(/^www\./, '')
      const known = [...hosts].some((k) => h === k || h.endsWith(`.${k}`) || k.endsWith(`.${h}`))
      if (!known) odd.add(h)
    }
    if (odd.size) out.push(`links to other sites: ${[...odd].slice(0, 5).join(', ')}`)
  }
  return out
}

/** A small line diff (LCS) as "+ " / "- " lines with two lines of context; '' when equal. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 4_000_000) return '(too long to compare: the whole skill changed)'
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops: { t: ' ' | '+' | '-'; s: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i] })
      i++
      j++
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ t: '-', s: a[i++] })
    else ops.push({ t: '+', s: b[j++] })
  }
  if (!ops.some((o) => o.t !== ' ')) return ''
  const keep = ops.map((_, k) =>
    ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== ' ')
  )
  const out: string[] = []
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.t} ${o.s}`)
    else if (k === 0 || keep[k - 1]) out.push('…')
  })
  return out.join('\n')
}
