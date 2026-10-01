// "Summarize this file" while pointing at a file in File Explorer or on the desktop: the
// agent's element_at gives the list item under the pointer and its window; the folder comes
// from the Explorer window (Shell.Application, matched by window handle and title for tabs)
// or the desktop folders. The item's shown name may hide the extension, so the folder is
// listed for a matching name. The file then goes through the same checks as a drop.
import type { Point } from '@shared/types'
import { extname } from 'path'
import { ALLOWED_EXTENSIONS } from './store'

export interface ElementAtResult {
  element?: { role: string; name: string }
  item?: { role: string; name: string } | null
  window?: { hwnd: number; className: string; process: string; title: string }
}

export type Surface = 'explorer' | 'desktop'

/** File Explorer (CabinetWClass) or the desktop (Progman / WorkerW), by window. */
export function surfaceOf(w: ElementAtResult['window']): Surface | null {
  if (!w || (w.process ?? '').toLowerCase() !== 'explorer.exe') return null
  if (w.className === 'CabinetWClass' || w.className === 'ExploreWClass') return 'explorer'
  if (w.className === 'Progman' || w.className === 'WorkerW') return 'desktop'
  return null
}

export interface ShellWindow {
  hwnd: number
  path: string
  /** The tab's folder name as shown in the title ("Documents"). */
  name: string
}

/**
 * The folder of the Explorer window under the pointer. Tabs share one window handle; the
 * active tab's name starts the window title ("Documents - File Explorer"). Folders that are
 * not on disk (This PC, Quick access, libraries without a path) are skipped.
 */
export function explorerFolders(
  wins: readonly ShellWindow[],
  hwnd: number,
  title: string
): string[] {
  const mine = wins.filter((w) => w.hwnd === hwnd && /^[a-z]:[\\/]/i.test(w.path))
  if (mine.length <= 1) return mine.map((w) => w.path)
  const t = title.toLowerCase()
  const titled = mine.filter((w) => w.name && t.startsWith(w.name.toLowerCase()))
  return (titled.length ? titled : mine).map((w) => w.path)
}

const readable = (e: string): boolean => ALLOWED_EXTENSIONS.includes(extname(e).toLowerCase())

/**
 * Files in a folder listing that the shown name means: the exact name, else the name without
 * a hidden extension. Files Lumen can read come first.
 */
export function matchShownName(shown: string, entries: readonly string[]): string[] {
  const s = shown.trim().toLowerCase()
  if (!s) return []
  const exact = entries.filter((e) => e.toLowerCase() === s)
  if (exact.length) return exact
  const stem = entries.filter((e) => {
    const ext = extname(e)
    return ext && e.slice(0, -ext.length).toLowerCase() === s
  })
  return [...stem.filter(readable), ...stem.filter((e) => !readable(e))]
}

export interface PointedDeps {
  elementAt(p: Point): Promise<ElementAtResult | null>
  shellWindows(): Promise<ShellWindow[]>
  desktopFolders(): string[]
  /** Folder entry names (files only); [] when it cannot be read. */
  list(dir: string): Promise<string[]>
  join(dir: string, name: string): string
}

export type Pointed =
  | { ok: true; path: string }
  | { ok: false; error: string }
  /** Not pointing at a file at all (the request is about something else). */
  | null

/** The file under the pointer, or null when the pointer is not on a file item. */
export async function fileAt(p: Point, deps: PointedDeps): Promise<Pointed> {
  const at = await deps.elementAt(p).catch(() => null)
  const surface = surfaceOf(at?.window)
  const item = at?.item
  if (!at || !surface || !item?.name) return null
  const folders =
    surface === 'desktop'
      ? deps.desktopFolders()
      : explorerFolders(
          await deps.shellWindows().catch(() => []),
          at.window?.hwnd ?? 0,
          at.window?.title ?? ''
        )
  if (!folders.length)
    return {
      ok: false,
      error: 'I can see the file but not which folder it is in. Drag it onto the bar instead.'
    }
  const hits: string[] = []
  for (const dir of folders) {
    const names = matchShownName(item.name, await deps.list(dir))
    const ok = names.filter(readable)
    if (ok.length > 1)
      return {
        ok: false,
        error: `There are several files called ${item.name} (${ok.join(', ')}). Drag the one you mean onto the bar.`
      }
    if (names.length) hits.push(deps.join(dir, ok[0] ?? names[0]))
  }
  if (!hits.length)
    return {
      ok: false,
      error: `That looks like a folder or a shortcut, not a file I can read (${item.name}).`
    }
  return { ok: true, path: hits[0] }
}

/** Requests about the thing under the pointer: "this file", "summarize this", "convert that". */
const POINTED_FILE =
  /\b(this|that|these)\s+(file|document|doc|pdf|spreadsheet|sheet|workbook|csv|presentation|deck|slides|report|text|table|image|picture|photo|one)\b|\b(file|document) (here|under (my|the) (cursor|mouse|pointer))\b/i
const VERB_THIS =
  /\b(summari[sz]e|read|explain|analy[sz]e|review|proofread|translate|convert|turn|reformat|clean up|tidy up|make|export|extract|check|open)\b[^.?!]{0,30}\b(this|that|it)\b/i

export function mentionsPointedFile(prompt: string): boolean {
  return POINTED_FILE.test(prompt) || VERB_THIS.test(prompt)
}

// ---- Electron side ----

const SHELL_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$o=foreach($w in (New-Object -ComObject Shell.Application).Windows()){try{$p=$w.Document.Folder.Self.Path;if($p){[pscustomobject]@{hwnd=[int64]$w.HWND;path=$p;name=$w.LocationName}}}catch{}}',
  '@($o)|ConvertTo-Json -Compress'
].join(';')

function shellWindows(): Promise<ShellWindow[]> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([])
    void import('child_process').then(({ execFile }) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', SHELL_SCRIPT],
        { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve([])
          try {
            const v = JSON.parse(stdout.trim() || '[]') as unknown
            const list = (Array.isArray(v) ? v : [v]) as Partial<ShellWindow>[]
            resolve(
              list
                .filter((w) => typeof w?.path === 'string' && typeof w.hwnd === 'number')
                .map((w) => ({ hwnd: w.hwnd!, path: w.path!, name: String(w.name ?? '') }))
            )
          } catch {
            resolve([])
          }
        }
      )
    )
  })
}

export async function realPointedDeps(): Promise<PointedDeps> {
  const { app } = await import('electron')
  const { readdir } = await import('fs/promises')
  const { join } = await import('path')
  const { getAgent } = await import('../agent/instance')
  return {
    elementAt: async (p) => {
      const agent = getAgent()
      if (!agent?.hasCapability('element-at')) return null
      return agent.request<ElementAtResult>(
        'element_at',
        { x: Math.round(p.x), y: Math.round(p.y) },
        { timeoutMs: 1500 }
      )
    },
    shellWindows,
    desktopFolders: () =>
      [
        app.getPath('desktop'),
        process.env.PUBLIC ? join(process.env.PUBLIC, 'Desktop') : ''
      ].filter(Boolean),
    list: async (dir) => {
      try {
        return (await readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isFile() || d.isSymbolicLink())
          .map((d) => d.name)
      } catch {
        return []
      }
    },
    join
  }
}
