// Known-app registry (T08, safety-policy §1): the only apps launch_app can start. Entries come
// from Start menu shortcuts (.lnk under ProgramData and AppData) and, once per session, the
// packaged apps `Get-StartApps` lists. The model names an app; the registry picks the entry and
// launches the shortcut path or AppUserModelID it found itself. Model-supplied paths, URLs and
// arguments are never launched.
import { execFile } from 'child_process'
import { readdirSync } from 'fs'
import { basename, join } from 'path'

export interface AppEntry {
  /** Display name ("Blender 4.2"). */
  name: string
  /** A .lnk path found by the registry, or a packaged app's AppUserModelID. */
  launch: { kind: 'lnk'; path: string } | { kind: 'aumid'; id: string }
}

export interface AppSources {
  /** Start menu folders to scan for .lnk files. */
  startMenuDirs(): string[]
  listDir(dir: string): { name: string; dir: boolean }[]
  /** Packaged apps: [{Name, AppID}] from Get-StartApps; [] when unavailable. */
  startApps(): Promise<{ Name: string; AppID: string }[]>
}

// Shortcuts that are not apps: uninstallers, help files, readmes, web links.
const NOT_AN_APP_RE =
  /\b(uninstall|uninstaller|readme|help|documentation|license|release notes|website|on the web)\b/i
const MAX_DEPTH = 4

function scan(sources: AppSources, dir: string, depth: number, out: AppEntry[]): void {
  if (depth > MAX_DEPTH) return
  let items: { name: string; dir: boolean }[]
  try {
    items = sources.listDir(dir)
  } catch {
    return
  }
  for (const it of items) {
    const path = join(dir, it.name)
    if (it.dir) scan(sources, path, depth + 1, out)
    else if (/\.lnk$/i.test(it.name)) {
      const name = basename(it.name, '.lnk').trim()
      if (name && !NOT_AN_APP_RE.test(name)) out.push({ name, launch: { kind: 'lnk', path } })
    }
  }
}

/** Every known app; shortcuts win over packaged entries with the same name. */
export async function buildRegistry(sources: AppSources): Promise<AppEntry[]> {
  const out: AppEntry[] = []
  for (const dir of sources.startMenuDirs()) scan(sources, dir, 0, out)
  const seen = new Set(out.map((e) => norm(e.name)))
  for (const a of await sources.startApps().catch(() => [])) {
    if (!a?.Name || !a.AppID || seen.has(norm(a.Name))) continue
    // Shortcut-backed entries in Get-StartApps are paths; those came from the scan already.
    if (/[\\/]/.test(a.AppID) && !a.AppID.includes('!')) continue
    seen.add(norm(a.Name))
    out.push({ name: a.Name, launch: { kind: 'aumid', id: a.AppID } })
  }
  return out
}

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(exe|lnk)$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/**
 * Score of `entry` for the query: 1 exact, 0.9 the name starts with the query as a word
 * ("blender" → "Blender 4.2"), 0.8 every query word is in the name, else a typo-tolerant ratio.
 */
export function scoreApp(query: string, entry: AppEntry): number {
  const q = norm(query)
  const n = norm(entry.name)
  if (!q || !n) return 0
  if (q === n) return 1
  if (n.startsWith(q + ' ')) return 0.9
  const words = q.split(' ')
  const nameWords = n.split(' ')
  if (words.every((w) => nameWords.includes(w))) return 0.8
  const d = editDistance(q, n.slice(0, Math.max(q.length, nameWords[0].length)))
  return Math.max(0, 1 - d / Math.max(q.length, 4)) * 0.75
}

export const MIN_APP_SCORE = 0.6

/** Best match, or null with the closest names for the error message. */
export function findApp(
  query: string,
  registry: AppEntry[]
): { entry: AppEntry | null; closest: string[] } {
  // Paths, URLs and command lines are never app names.
  if (/[\\/:]|\.exe\b|\s-{1,2}\w/i.test(query)) return { entry: null, closest: [] }
  const ranked = registry
    .map((e) => ({ e, s: scoreApp(query, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.name.length - b.e.name.length)
  const best = ranked[0]
  return {
    entry: best && best.s >= MIN_APP_SCORE ? best.e : null,
    closest: ranked.slice(0, 3).map((x) => x.e.name)
  }
}

// ---- Real sources (Windows) ----

const GET_START_APPS_MS = 8000

export const windowsSources: AppSources = {
  startMenuDirs: () =>
    [
      process.env.ProgramData &&
        join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      process.env.APPDATA &&
        join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ].filter((d): d is string => !!d),
  listDir: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })),
  startApps: () =>
    new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve([])
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'
        ],
        { timeout: GET_START_APPS_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve([])
          try {
            const v = JSON.parse(stdout) as unknown
            resolve((Array.isArray(v) ? v : [v]) as { Name: string; AppID: string }[])
          } catch {
            resolve([])
          }
        }
      )
    })
}

const REGISTRY_TTL_MS = 10 * 60_000
let cached: { at: number; entries: Promise<AppEntry[]> } | null = null

/** The registry, built once and refreshed after 10 minutes (new installs). */
export function appRegistry(
  sources: AppSources = windowsSources,
  now = Date.now()
): Promise<AppEntry[]> {
  if (!cached || now - cached.at > REGISTRY_TTL_MS) {
    const entries = buildRegistry(sources)
    entries.catch(() => (cached = null))
    cached = { at: now, entries }
  }
  return cached.entries
}

/** Test hook. */
export function resetAppRegistry(): void {
  cached = null
}

export interface Launcher {
  openPath(path: string): Promise<string>
  openAumid(id: string): Promise<void>
}

/** Starts a registry entry (never anything else). Rejects with the shell's error. */
export async function launchEntry(entry: AppEntry, launcher: Launcher): Promise<void> {
  if (entry.launch.kind === 'lnk') {
    const err = await launcher.openPath(entry.launch.path)
    if (err) throw new Error(err)
    return
  }
  await launcher.openAumid(entry.launch.id)
}
