// Importing an existing Claude skill: a local folder (a skill folder with SKILL.md, a
// .claude/skills or plugin skills/ folder holding several) or a GitHub link (repo, tree/<ref>/
// <path> or a blob link to a SKILL.md), downloaded as the repo zip through the pack fetcher's
// host allowlist and read with the strict zip reader. Text files only; nothing runs. Several
// skills in one place: the caller names one ("import the pdf skill from …").
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join, relative, sep } from 'path'
import { fetchPack, githubPackSource } from '../packs/fetch'
import { readZip } from '../packs/zip-read'
import { MAX_FILE_BYTES, MAX_FILES, safeRel } from './library'
import { parseSkillMd, sanitizeSkillMd, type ParsedSkillMd } from './skillmd'

/** Files kept from an imported skill folder (text a skill may reference). */
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|csv|xml|html?|js|mjs|cjs|ts|py|sh|ps1|sql)$/i
const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|sh|ps1)$/i
const MAX_SCAN = 4000

/** Relative path (forward slashes) → contents. */
export type FileSet = Map<string, Buffer>

export interface ImportedSkill {
  parsed: ParsedSkillMd
  skillMd: string
  files: { path: string; text: string }[]
  /** Scripts in the folder (Claude may run them when it uses the skill). */
  scripts: string[]
  /** What re-rendering removed (header settings, load-time commands). */
  notes: string[]
  from: string
}

/** Reads a local folder into a FileSet (plain files, no links, size-capped). */
export function folderFiles(root: string): FileSet {
  const out: FileSet = new Map()
  let seen = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    for (const e of readdirSync(dir)) {
      if (++seen > MAX_SCAN) return
      if (e === 'node_modules' || e === '.git') continue
      const p = join(dir, e)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(p, depth + 1)
      else if (st.isFile() && st.size <= MAX_FILE_BYTES && (e === 'SKILL.md' || TEXT_EXT.test(e)))
        out.set(relative(root, p).split(sep).join('/'), readFileSync(p))
    }
  }
  walk(root, 0)
  return out
}

/** Every folder in the set that holds a SKILL.md ('' = the root). */
export function skillFolders(files: FileSet): string[] {
  return [...files.keys()]
    .filter((p) => p === 'SKILL.md' || p.endsWith('/SKILL.md'))
    .map((p) => p.slice(0, -'SKILL.md'.length).replace(/\/$/, ''))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

/** One skill out of a FileSet; `pick` names it when there are several. */
export function pickSkill(files: FileSet, from: string, pick?: string): ImportedSkill {
  const folders = skillFolders(files)
  if (!folders.length) throw new Error('there is no SKILL.md there')
  const named = folders.map((f) => ({ f, name: f ? basename(f) : basename(from) }))
  let hit = named.length === 1 ? named[0] : undefined
  if (pick) {
    const want = pick.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    hit =
      named.find((n) => n.name.toLowerCase() === want) ??
      named.find((n) => {
        try {
          return (
            parseSkillMd(files.get(n.f ? `${n.f}/SKILL.md` : 'SKILL.md')!.toString('utf8'), n.name)
              .name === want
          )
        } catch {
          return false
        }
      })
    if (!hit) throw new Error(`there is no skill called ${pick} there`)
  }
  if (!hit)
    throw new Error(
      `there are ${named.length} skills there: ${named
        .slice(0, 8)
        .map((n) => n.name)
        .join(', ')}. Say which one`
    )
  const prefix = hit.f ? `${hit.f}/` : ''
  // Re-rendered: allowed-tools, hooks, model … and !`cmd` lines never reach Claude Code.
  const { skillMd, parsed, notes } = sanitizeSkillMd(
    files.get(`${prefix}SKILL.md`)!.toString('utf8'),
    hit.name.toLowerCase()
  )
  const extra: { path: string; text: string }[] = []
  const scripts: string[] = []
  for (const [p, data] of files) {
    if (!p.startsWith(prefix) || p === `${prefix}SKILL.md`) continue
    const rel = safeRel(p.slice(prefix.length))
    // Another skill nested below this one is not part of it.
    if (!rel || !TEXT_EXT.test(rel) || data.length > MAX_FILE_BYTES) continue
    if (folders.some((f) => f !== hit!.f && f.startsWith(prefix) && p.startsWith(`${f}/`))) continue
    extra.push({ path: rel, text: data.toString('utf8') })
    if (SCRIPT_EXT.test(rel)) scripts.push(rel)
  }
  if (extra.length > MAX_FILES) throw new Error('that skill has too many files')
  return { parsed, skillMd, files: extra, scripts, notes, from }
}

/** A blob link to a file → the tree link of its folder (the pack fetcher takes trees). */
export function githubTreeLink(link: string): string {
  const u = new URL(link.trim())
  const m = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(u.pathname)
  if (u.hostname.toLowerCase() !== 'github.com' || !m) return link.trim()
  const dir = m[4].split('/').slice(0, -1).join('/')
  return `https://github.com/${m[1]}/${m[2]}/tree/${m[3]}${dir ? `/${dir}` : ''}`
}

/** The repo zip's files under the link's folder, without the zip's top folder. */
export function zipFiles(buf: Buffer, subpath?: string): FileSet {
  const out: FileSet = new Map()
  const sub = subpath ? `${subpath.replace(/^\/|\/$/g, '')}/` : ''
  for (const f of readZip(buf)) {
    const rest = f.name.split('/').slice(1).join('/')
    if (!rest || rest.endsWith('/') || !rest.startsWith(sub)) continue
    const rel = rest.slice(sub.length)
    const leaf = rel.split('/').pop() ?? ''
    if (leaf === 'SKILL.md' || TEXT_EXT.test(leaf)) out.set(rel, f.data)
  }
  return out
}

export interface ImportDeps {
  fetchZip?: (url: string, signal?: AbortSignal) => Promise<Buffer>
  signal?: AbortSignal
}

/** A local folder or a GitHub link → one skill. */
export async function importSkill(
  from: string,
  pick: string | undefined,
  deps: ImportDeps = {}
): Promise<ImportedSkill> {
  const src = from.trim()
  if (/^https?:\/\//i.test(src)) {
    const pack = githubPackSource(githubTreeLink(src))
    const fetchZip = deps.fetchZip ?? ((u, signal) => fetchPack(u, { signal }))
    const buf = await fetchZip(pack.url, deps.signal)
    return pickSkill(zipFiles(buf, pack.subpath), pack.subpath ?? pack.label, pick)
  }
  if (!existsSync(src) || !statSync(src).isDirectory())
    throw new Error('that folder does not exist')
  return pickSkill(folderFiles(src), src, pick)
}
