// Claude Code plugin layout (code.claude.com/docs/en/plugins/manifest-reference, checked
// 2026-10-01): which plugins a file tree holds and where their parts are. A tree is a
// marketplace (.claude-plugin/marketplace.json listing plugins by path), one plugin
// (.claude-plugin/plugin.json and/or the default folders), or bare skills (<name>/SKILL.md).
// Component paths in plugin.json are "./"-relative and never leave the plugin. Pure: works on
// an in-memory file list (from a zip or a folder read). No Electron.
import type { PluginSkipped } from '@shared/plugins'

export interface TreeFile {
  /** Forward-slash path relative to the tree root. */
  name: string
  data: Buffer
}

export interface FoundPlugin {
  name: string
  version?: string
  description?: string
  author?: string
  license?: string
  /** Folder prefix inside the tree ("" or "plugins/x/"). */
  prefix: string
  /** plugin.json merged over the marketplace entry. */
  manifest: Record<string, unknown>
}

const MARKETPLACE = '.claude-plugin/marketplace.json'
const PLUGIN_JSON = '.claude-plugin/plugin.json'
const DEFAULT_PARTS = ['skills/', 'commands/', 'output-styles/', 'agents/', 'hooks/']

export function readJson(files: readonly TreeFile[], name: string): Record<string, unknown> | null {
  const f = files.find((x) => x.name === name)
  if (!f) return null
  try {
    const v = JSON.parse(f.data.toString('utf8').trimStart()) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown, max = 300): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

/** "./a/b" or "a/b" under `prefix` → "prefix/a/b"; null when it leaves the root. */
export function joinRel(prefix: string, rel: string): string | null {
  const parts = rel.replace(/\\/g, '/').split('/')
  const out = prefix.split('/').filter(Boolean)
  const depth = out.length
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') return null
    out.push(p)
  }
  return out.length >= depth ? out.join('/') : null
}

/** Drops a single top folder shared by every file (GitHub zips: "<repo>-<ref>/"). */
export function stripTop(files: readonly TreeFile[]): TreeFile[] {
  const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')))
  if (tops.size !== 1 || tops.has('')) return [...files]
  const top = [...tops][0]
  return files.map((f) => ({ name: f.name.slice(top.length + 1), data: f.data }))
}

/** Files under "sub/" with the prefix removed. */
export function under(files: readonly TreeFile[], sub: string): TreeFile[] {
  const p = sub.replace(/^\/+|\/+$/g, '')
  if (!p) return [...files]
  return files
    .filter((f) => f.name.startsWith(`${p}/`))
    .map((f) => ({ name: f.name.slice(p.length + 1), data: f.data }))
}

function authorOf(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v, 80)
  if (v && typeof v === 'object') return str((v as Record<string, unknown>).name, 80)
  return undefined
}

function pluginAt(
  files: readonly TreeFile[],
  prefix: string,
  entry: Record<string, unknown> = {}
): FoundPlugin {
  const own = readJson(files, `${prefix}${PLUGIN_JSON}`) ?? {}
  const manifest = { ...entry, ...own }
  delete manifest.source
  const folder = prefix.replace(/\/$/, '').split('/').pop() || 'plugin'
  return {
    name: str(manifest.name, 64) ?? folder,
    ...(str(manifest.version, 40) ? { version: str(manifest.version, 40) } : {}),
    ...(str(manifest.description) ? { description: str(manifest.description) } : {}),
    ...(authorOf(manifest.author) ? { author: authorOf(manifest.author) } : {}),
    ...(str(manifest.license, 80) ? { license: str(manifest.license, 80) } : {}),
    prefix,
    manifest
  }
}

function sourceLabel(src: Record<string, unknown>): string {
  const kind = str(src.source, 20) ?? 'unknown'
  const where = str(src.repo, 200) ?? str(src.url, 200) ?? str(src.package, 200) ?? ''
  return `${kind}${where ? ` ${where}` : ''}`
}

/** The plugins in a tree, and what was left out (plugins that live elsewhere). */
export function findPlugins(files: readonly TreeFile[]): {
  plugins: FoundPlugin[]
  skipped: PluginSkipped[]
} {
  const skipped: PluginSkipped[] = []
  const market = readJson(files, MARKETPLACE)
  if (market && Array.isArray(market.plugins)) {
    const meta = (market.metadata ?? {}) as Record<string, unknown>
    const pluginRoot = str(meta.pluginRoot) ?? ''
    const plugins: FoundPlugin[] = []
    for (const raw of market.plugins.slice(0, 200)) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const name = str(entry.name, 64) ?? 'plugin'
      const src = entry.source
      if (typeof src !== 'string') {
        const where =
          src && typeof src === 'object' ? sourceLabel(src as Record<string, unknown>) : ''
        skipped.push({
          what: `plugin "${name}"`,
          why: `it lives in another place (${where || 'unknown source'}); import that link on its own`
        })
        continue
      }
      const rel = src.startsWith('./') || src.startsWith('../') ? src : `${pluginRoot}/${src}`
      const path = joinRel('', rel)
      if (path === null) {
        skipped.push({ what: `plugin "${name}"`, why: 'its path leaves the marketplace folder' })
        continue
      }
      const prefix = path ? `${path}/` : ''
      if (!files.some((f) => f.name.startsWith(prefix))) {
        skipped.push({ what: `plugin "${name}"`, why: 'its folder is not in the download' })
        continue
      }
      plugins.push(pluginAt(files, prefix, entry))
    }
    return { plugins, skipped }
  }
  const isPlugin =
    files.some((f) => f.name === PLUGIN_JSON || f.name === '.mcp.json') ||
    files.some((f) => DEFAULT_PARTS.some((p) => f.name.startsWith(p)))
  if (isPlugin) return { plugins: [pluginAt(files, '')], skipped }
  if (files.some((f) => f.name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(f.name)))
    return {
      plugins: [{ name: 'skills', prefix: '', manifest: { skills: ['./'] } }],
      skipped
    }
  return { plugins: [], skipped }
}

/** Plugin.json component paths: a string or a list of strings. */
export function pathList(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}
