// Marketplace plugins that live in another place (code.claude.com/docs/en/plugins/
// marketplace-reference "Plugin sources", checked 2026-10-02). Lumen fetches the ones on GitHub
// the same way as a pasted link: `github` {repo, ref, sha}, `url` and `git-subdir` {url, path,
// ref, sha} when the git URL is on github.com (or `owner/repo` shorthand for git-subdir) become a
// codeload.github.com zip, and an `archive` {url, sha256} is fetched only from the pack hosts
// (with its sha256 checked when given). Every download goes through packs/fetch (https, host
// allowlist on every redirect, 50 MB) and the strict packs/zip-read. Other git hosts, npm and
// command sources are listed as not imported. The fetcher is passed in, so this is testable
// without the network. No Electron.
import { createHash } from 'crypto'
import type { PluginSkipped } from '@shared/plugins'
import { checkUrl, PACK_HOSTS } from '../downloads/verified-download'
import { BUDGET_EXCEEDED } from '../packs/fetch'
import { readZip, ZIP_LIMITS } from '../packs/zip-read'
import {
  pluginAt,
  stripTop,
  under,
  type FoundPlugin,
  type RemoteEntry,
  type TreeFile
} from './layout'

export interface RemoteDownload {
  /** https download address (codeload zip or an archive on a pack host). */
  url: string
  /** Folder inside the zip (git-subdir `path`). */
  subpath?: string
  /** Lowercase hex digest the download must have (archive `sha256`). */
  sha256?: string
  /** Where it comes from, for messages. */
  label: string
}

export interface FetcherOptions {
  /** One download's own cap (zip limit). */
  maxBytes: number
  /** What all downloads of this import may still take, counted down as data arrives. */
  budget: { left: number }
  signal: AbortSignal
}

export type Fetcher = (url: string, opts: FetcherOptions) => Promise<Buffer>

/** At most this many plugins are fetched for one import; the rest are listed. */
export const MAX_REMOTE_PLUGINS = 12
/** All remote downloads of one import together. */
export const MAX_REMOTE_BYTES = 150 * 1024 * 1024

const SEG = /^[A-Za-z0-9._-]+$/
const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-fA-F]{64}$/
const REF = /^[A-Za-z0-9._/+-]{1,200}$/

const PLUGIN_ROOT =
  /^(?:\.claude-plugin\/|\.mcp\.json$|(?:skills|commands|output-styles|agents|hooks)\/)/

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** "owner/repo" from a GitHub git URL or (when `shorthand`) owner/repo; null otherwise. */
export function githubRepo(raw: string, shorthand = false): string | null {
  let path: string
  if (/^git@github\.com:/i.test(raw)) path = raw.slice('git@github.com:'.length)
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return null
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.hostname.toLowerCase() !== 'github.com' && u.hostname.toLowerCase() !== 'www.github.com')
      return null
    path = u.pathname
  } else if (shorthand) path = raw
  else return null
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length !== 2) return null
  const [owner, repoRaw] = parts
  const repo = repoRaw.replace(/\.git$/i, '')
  if (!SEG.test(owner) || !SEG.test(repo) || repo === '.' || repo === '..') return null
  return `${owner}/${repo}`
}

function hostOf(raw: string): string {
  const m = /^git@([^:]+):/.exec(raw)
  if (m) return m[1]
  try {
    return new URL(raw).hostname
  } catch {
    return 'an unknown place'
  }
}

/** sha (pinned commit) first, then ref, else the default branch. */
function gitRef(src: Record<string, unknown>): string | null {
  const sha = str(src.sha).toLowerCase()
  if (sha) return SHA1.test(sha) ? sha : null
  const ref = str(src.ref)
  if (!ref) return 'HEAD'
  return REF.test(ref) && !ref.split('/').includes('..') ? ref : null
}

function codeload(repo: string, ref: string): string {
  return `https://codeload.github.com/${repo}/zip/${encodeURIComponent(ref)}`
}

/** What to download for a marketplace source object, or why it is not imported. */
export function remoteDownload(
  src: Record<string, unknown>
): { ok: true; download: RemoteDownload } | { ok: false; why: string } {
  const kind = str(src.source)
  if (kind === 'github' || kind === 'url' || kind === 'git-subdir') {
    const where = kind === 'github' ? str(src.repo) : str(src.url)
    const repo =
      kind === 'github' ? githubRepo(where, true) : githubRepo(where, kind === 'git-subdir')
    if (!repo)
      return {
        ok: false,
        why:
          kind === 'github'
            ? 'its GitHub repository name is not valid'
            : `it is a git repository on ${hostOf(where)}; Lumen only downloads plugins from GitHub`
      }
    const ref = gitRef(src)
    if (!ref) return { ok: false, why: 'its branch, tag or commit is not valid' }
    let subpath: string | undefined
    if (kind === 'git-subdir') {
      const p = str(src.path)
        .replace(/\\/g, '/')
        .replace(/^\.?\/+|\/+$/g, '')
      if (!p || p.split('/').some((x) => !x || x === '.' || x === '..'))
        return { ok: false, why: 'its folder path is not valid' }
      subpath = p
    }
    return {
      ok: true,
      download: {
        url: codeload(repo, ref),
        ...(subpath ? { subpath } : {}),
        label: `github ${repo}${ref === 'HEAD' ? '' : `@${ref}`}${subpath ? `/${subpath}` : ''}`
      }
    }
  }
  if (kind === 'archive') {
    const url = str(src.url)
    try {
      checkUrl(url, PACK_HOSTS)
    } catch {
      return {
        ok: false,
        why: `its zip is on ${hostOf(url)}; Lumen only downloads plugins from GitHub`
      }
    }
    const sha = str(src.sha256)
    if (sha && !SHA256.test(sha)) return { ok: false, why: 'its sha256 is not valid' }
    return {
      ok: true,
      download: { url, ...(sha ? { sha256: sha.toLowerCase() } : {}), label: `zip ${url}` }
    }
  }
  if (kind === 'npm')
    return { ok: false, why: 'it is an npm package; Lumen does not download from npm' }
  if (kind === 'command')
    return { ok: false, why: 'it runs a command on your PC to make the plugin; Lumen never does' }
  return { ok: false, why: `its source type (${kind || 'none'}) is not supported` }
}

export interface RemotePlugin {
  plugin: FoundPlugin
  files: TreeFile[]
}

/** The files of one download, or a plain reason it failed. */
function unpack(archive: Buffer, d: RemoteDownload): TreeFile[] {
  if (d.sha256) {
    const got = createHash('sha256').update(archive).digest('hex')
    if (got !== d.sha256) throw new Error('the download does not match its sha256')
  }
  let files: TreeFile[]
  try {
    const raw = readZip(archive, ZIP_LIMITS)
    // A plugin zip may hold the plugin at its top or one folder down (repo zips always do).
    files = raw.some((f) => PLUGIN_ROOT.test(f.name)) ? raw : stripTop(raw)
  } catch (e) {
    throw new Error(`not a usable download: ${(e as Error).message}`)
  }
  return files
}

/**
 * Marketplace plugins that live elsewhere, for a folder or ~/.claude import: those stay offline,
 * so the plugins are only listed. A GitHub link import (already online) fetches them.
 */
export function remoteNotFetched(remote: readonly RemoteEntry[]): PluginSkipped[] {
  return remote.map((r) => ({
    what: `plugin "${r.name}"`,
    why: 'it lives in another place and a folder import stays offline; import the marketplace’s GitHub link to fetch it'
  }))
}

/**
 * Fetches the remote marketplace entries (each distinct download once, 3 at a time) and returns
 * them as plugins with their own file trees, plus what was left out. All downloads share one
 * running byte budget: once it is spent, the downloads still running stop and the rest are not
 * started. `signal` (cancel) stops them the same way.
 */
export async function fetchRemotePlugins(
  remote: readonly RemoteEntry[],
  fetcher: Fetcher,
  opts: { max?: number; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ plugins: RemotePlugin[]; skipped: PluginSkipped[] }> {
  const skipped: PluginSkipped[] = []
  const todo: { r: RemoteEntry; d: RemoteDownload }[] = []
  const max = opts.max ?? MAX_REMOTE_PLUGINS
  for (const r of remote) {
    const what = `plugin "${r.name}"`
    const res = remoteDownload(r.source)
    if (!res.ok) skipped.push({ what, why: res.why })
    else if (todo.length >= max)
      skipped.push({
        what,
        why: `only ${max} plugins from other places are fetched at once; import its own link`
      })
    else todo.push({ r, d: res.download })
  }

  const budget = { left: opts.maxBytes ?? MAX_REMOTE_BYTES }
  const stop = new AbortController()
  const onCancel = (): void => stop.abort()
  if (opts.signal?.aborted) stop.abort()
  opts.signal?.addEventListener('abort', onCancel, { once: true })
  let overBudget = false
  // Each distinct download once; its buffer is dropped once every entry that uses it is unpacked.
  const users = new Map<string, number>()
  for (const { d } of todo) users.set(d.url, (users.get(d.url) ?? 0) + 1)
  const downloads = new Map<string, Promise<Buffer>>()
  const get = (url: string): Promise<Buffer> => {
    let p = downloads.get(url)
    if (!p) {
      p = fetcher(url, {
        maxBytes: Math.min(ZIP_LIMITS.maxBytes, Math.max(0, budget.left)),
        budget,
        signal: stop.signal
      }).catch((e: Error) => {
        if (budget.left < 0 || e.message === BUDGET_EXCEEDED) {
          overBudget = true
          stop.abort()
        }
        throw e
      })
      downloads.set(url, p)
    }
    return p
  }
  const done = (url: string): void => {
    const n = (users.get(url) ?? 1) - 1
    users.set(url, n)
    if (n <= 0) downloads.delete(url)
  }

  const out: (RemotePlugin | null)[] = new Array(todo.length).fill(null)
  const failed: (PluginSkipped | null)[] = new Array(todo.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const i = next++
      const { r, d } = todo[i]
      const what = `plugin "${r.name}"`
      if (stop.signal.aborted) {
        failed[i] = {
          what,
          why: overBudget
            ? 'the plugins from other places are too large together'
            : 'the download was cancelled'
        }
        continue
      }
      try {
        let files: TreeFile[]
        try {
          files = unpack(await get(d.url), d)
        } finally {
          done(d.url)
        }
        if (d.subpath) files = under(files, d.subpath)
        if (!files.length) {
          failed[i] = { what, why: `its folder is empty or missing (${d.label})` }
          continue
        }
        const entry: Record<string, unknown> = { name: r.name, ...r.entry }
        delete entry.source
        out[i] = { plugin: pluginAt(files, '', entry), files }
      } catch (e) {
        failed[i] = {
          what,
          why: overBudget
            ? 'the plugins from other places are too large together'
            : `it could not be downloaded from ${d.label} (${(e as Error).message.slice(0, 120)})`
        }
      }
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()])
  } finally {
    opts.signal?.removeEventListener('abort', onCancel)
  }
  skipped.push(...failed.filter((f): f is PluginSkipped => f !== null))
  return { plugins: out.filter((p): p is RemotePlugin => p !== null), skipped }
}
