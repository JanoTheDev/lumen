// Skill packs (CONTRACTS C8): skills/<app-id>/{skill.json, overview.md, shortcuts.md, regions.json}.
// The pack matching the foreground app (process, then url, then title) adds its overview and a
// shortcuts excerpt to the user turn (capped, 1.5k tokens) and its named regions to the target
// resolver, so the model can point at "outliner" in apps that draw their own UI.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { estimateTokens } from './prompts/assemble'
import { log } from '../logger'

export type UiaQualityHint = 'good' | 'partial' | 'none'

/** A named area as fractions of the app's main window (regions.json). */
export interface SkillRegion {
  x: number
  y: number
  w: number
  h: number
  desc: string
  page?: string
}

export interface SkillPack {
  id: string
  name: string
  dir: string
  match: { process?: string[]; title?: string[]; url?: string[] }
  uiaQuality?: UiaQualityHint
  regions: Record<string, SkillRegion>
}

export const SKILL_TOKEN_CAP = 1500
const NON_PACK_DIRS = new Set(['schema', 'builtin', 'user'])

// Bundled main runs from out/main (in the asar when packaged); tests and scripts from the repo.
const DEFAULT_DIRS = [join(__dirname, '..', '..', 'skills'), join(process.cwd(), 'skills')]
let skillsDir = DEFAULT_DIRS.find((d) => existsSync(join(d, 'blender'))) ?? DEFAULT_DIRS[1]
let cache: SkillPack[] | null = null
const textCache = new Map<string, string>()

/** Where packs live (the app root's skills/ folder; inside the asar when packaged). */
export function setSkillsDir(dir: string): void {
  skillsDir = dir
  cache = null
  textCache.clear()
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readText(path: string): string {
  let t = textCache.get(path)
  if (t === undefined) {
    try {
      t = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      t = ''
    }
    textCache.set(path, t)
  }
  return t
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : undefined

function loadRegions(dir: string): Record<string, SkillRegion> {
  const raw = readJson(join(dir, 'regions.json')) as { regions?: Record<string, unknown> } | null
  const out: Record<string, SkillRegion> = {}
  for (const [name, r] of Object.entries(raw?.regions ?? {})) {
    const g = r as Partial<SkillRegion>
    const ok = [g.x, g.y, g.w, g.h].every((n) => typeof n === 'number' && n >= 0 && n <= 1)
    if (ok && g.w! > 0 && g.h! > 0)
      out[name] = { x: g.x!, y: g.y!, w: g.w!, h: g.h!, desc: String(g.desc ?? name), page: g.page }
  }
  return out
}

/** All packs with a valid skill.json, loaded once. */
export function skillPacks(): SkillPack[] {
  if (cache) return cache
  const packs: SkillPack[] = []
  let entries: string[] = []
  try {
    entries = existsSync(skillsDir) ? readdirSync(skillsDir) : []
  } catch {
    entries = []
  }
  for (const id of entries) {
    if (NON_PACK_DIRS.has(id)) continue
    const dir = join(skillsDir, id)
    const meta = readJson(join(dir, 'skill.json')) as Record<string, unknown> | null
    if (!meta || typeof meta.id !== 'string' || typeof meta.match !== 'object' || !meta.match)
      continue
    const m = meta.match as Record<string, unknown>
    packs.push({
      id: meta.id,
      name: typeof meta.name === 'string' ? meta.name : meta.id,
      dir,
      match: { process: strings(m.process), title: strings(m.title), url: strings(m.url) },
      uiaQuality: ['good', 'partial', 'none'].includes(meta.uiaQuality as string)
        ? (meta.uiaQuality as UiaQualityHint)
        : undefined,
      regions: loadRegions(dir)
    })
  }
  cache = packs
  log('plan', `skills: ${packs.length} packs from ${skillsDir}`)
  return packs
}

/** Title patterns are case-insensitive regexes (`^Settings$`); invalid ones match as text. */
function titleMatches(pattern: string, title: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(title)
  } catch {
    return title.toLowerCase().includes(pattern.toLowerCase())
  }
}

/** Url patterns are globs without the scheme (`figma.com/design/*`). */
function urlMatches(pattern: string, url: string): boolean {
  const re = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`(^|[/.])${re}`).test(url.toLowerCase().replace(/^[a-z]+:\/\//, ''))
}

const baseName = (p: string): string => p.split(/[\\/]/).pop()!.toLowerCase()

/** "C:\…\blender.exe" → "blender" (app name for per-app memory). */
export function appNameOf(process?: string): string | undefined {
  const base = process
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '')
  return base || undefined
}

export interface ForegroundApp {
  process?: string
  title?: string
  url?: string
}

/** The pack for the foreground app: process match first, then url, then title. */
export function matchSkill(fg: ForegroundApp, packs = skillPacks()): SkillPack | null {
  const proc = fg.process ? baseName(fg.process) : ''
  if (proc) {
    const hit = packs.find((p) => p.match.process?.some((x) => x.toLowerCase() === proc))
    if (hit) return hit
  }
  if (fg.url) {
    const hit = packs.find((p) => p.match.url?.some((x) => urlMatches(x, fg.url!)))
    if (hit) return hit
  }
  if (fg.title) {
    const hit = packs.find((p) => p.match.title?.some((x) => titleMatches(x, fg.title!)))
    if (hit) return hit
  }
  return null
}

const WORD_RE = /[\p{L}\p{N}]+/gu
const queryWords = (q: string): Set<string> =>
  new Set((q.toLowerCase().match(WORD_RE) ?? []).filter((w) => w.length > 2))

/** Trims markdown to a token budget by dropping whole sections from the end. */
function fitSections(md: string, budget: number): string {
  if (estimateTokens(md) <= budget) return md
  const parts = md.split(/\n(?=## )/)
  let out = ''
  for (const part of parts) {
    const next = out ? `${out}\n${part}` : part
    if (estimateTokens(next) > budget) break
    out = next
  }
  return out
}

interface ShortcutRow {
  section: string
  text: string
  score: number
  order: number
}

/** Table rows of shortcuts.md as compact lines; rows sharing words with the query rank first. */
export function shortcutsExcerpt(md: string, query: string, budget: number): string {
  if (budget <= 0) return ''
  const words = queryWords(query)
  const rows: ShortcutRow[] = []
  let section = ''
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) {
      section = h[1].trim()
      continue
    }
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 2 || /^action$/i.test(cells[0])) continue
    const [action, keys, ctx] = cells
    const text = `- ${action}: ${keys}${ctx && !/^any$/i.test(ctx) ? ` (${ctx})` : ''}`
    const rowWords = queryWords(`${action} ${section} ${ctx ?? ''}`)
    let score = 0
    for (const w of words) if (rowWords.has(w)) score++
    rows.push({ section, text, score, order: rows.length })
  }
  rows.sort((a, b) => b.score - a.score || a.order - b.order)
  const picked: ShortcutRow[] = []
  let used = estimateTokens('Shortcuts:\n')
  for (const r of rows) {
    const cost = estimateTokens(`${r.text}\n`)
    if (used + cost > budget) break
    picked.push(r)
    used += cost
  }
  if (!picked.length) return ''
  picked.sort((a, b) => a.order - b.order)
  return `Shortcuts:\n${picked.map((r) => r.text).join('\n')}`
}

/**
 * The pack text for the user turn: overview first (trimmed by section when long), then the
 * shortcuts most relevant to the request, within `cap` tokens in total.
 */
export function skillContext(pack: SkillPack, query: string, cap = SKILL_TOKEN_CAP): string {
  const overview = fitSections(readText(join(pack.dir, 'overview.md')).trim(), cap)
  const rest = cap - estimateTokens(overview) - 1
  const shortcuts = shortcutsExcerpt(readText(join(pack.dir, 'shortcuts.md')), query, rest)
  return [overview, shortcuts].filter(Boolean).join('\n\n')
}

/** Region names for the user turn (the overview describes them). */
export function regionsLine(pack: SkillPack): string {
  return Object.keys(pack.regions).join(', ')
}
