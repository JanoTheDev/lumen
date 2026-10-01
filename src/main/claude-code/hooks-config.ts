// Hook settings for Claude Code (08 T35/T38).
// - Per session: a --settings file whose http hooks point at Lumen's endpoint, with the token as
//   a literal header (the shape the 2026-10-01 probe verified). The files live under
//   ~/.ai-overlay/claude-code/run/ and are removed when the session closes and at start.
// - Global (opt-in, for sessions started by hand): Notification / Stop / SubagentStop hooks in
//   ~/.claude/settings.json. Lumen shows the exact diff and writes only after the user confirms
//   that exact file state (hash). Uninstall removes only Lumen's entries.
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ClaudeHooksPreview } from '@shared/claude-code'
import { claudeHome } from './projects'

export const HOOK_MARK = '/lumen-hook/'
const SESSION_EVENTS = ['PermissionRequest', 'Notification', 'Stop'] as const
const GLOBAL_EVENTS = ['Notification', 'Stop', 'SubagentStop'] as const
/** Extra seconds the global PermissionRequest hook waits beyond Lumen's own wait. */
const GLOBAL_PERMISSION_SLACK_S = 15

/** Opt-in: the global hooks also carry PermissionRequest, answered within `waitS` seconds. */
export interface GlobalHookOptions {
  permissions?: boolean
  waitS?: number
}
/** A permission waits for the user's voice answer; the CLI default is 600 s. */
const PERMISSION_TIMEOUT_S = 600
const NOTICE_TIMEOUT_S = 10

type Json = Record<string, unknown>

export function sessionSettings(base: string, key: string, token: string): Json {
  const hooks: Json = {}
  for (const event of SESSION_EVENTS)
    hooks[event] = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'http',
            url: `${base}${HOOK_MARK}s/${key}/${event}`,
            headers: { 'X-Lumen-Token': token },
            timeout: event === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : NOTICE_TIMEOUT_S
          }
        ]
      }
    ]
  return { hooks }
}

export function writeSessionSettings(
  dir: string,
  base: string,
  key: string,
  token: string
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${key}.json`)
  writeFileSync(file, JSON.stringify(sessionSettings(base, key, token), null, 2), 'utf8')
  return file
}

// ---- global hooks ----

export function userSettingsPath(): string {
  return join(claudeHome(), 'settings.json')
}

function isLumenHook(h: unknown): boolean {
  return !!h && typeof h === 'object' && String((h as Json).url ?? '').includes(HOOK_MARK)
}

/** The settings without any of Lumen's hook entries (empty groups and events dropped). */
export function withoutLumenHooks(settings: Json): Json {
  const out: Json = JSON.parse(JSON.stringify(settings)) as Json
  const hooks = out.hooks as Record<string, unknown> | undefined
  if (!hooks || typeof hooks !== 'object') return out
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups
      .map((g) => {
        if (!g || typeof g !== 'object' || !Array.isArray((g as Json).hooks)) return g
        const list = ((g as Json).hooks as unknown[]).filter((h) => !isLumenHook(h))
        return list.length ? { ...(g as Json), hooks: list } : null
      })
      .filter((g) => g !== null)
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }
  if (!Object.keys(hooks).length) delete out.hooks
  return out
}

export function withLumenHooks(
  settings: Json,
  base: string,
  token: string,
  opts: GlobalHookOptions = {}
): Json {
  const out = withoutLumenHooks(settings)
  const hooks = ((out.hooks as Json | undefined) ?? {}) as Record<string, unknown[]>
  const events: string[] = [...GLOBAL_EVENTS, ...(opts.permissions ? ['PermissionRequest'] : [])]
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : []
    hooks[event] = [
      ...groups,
      {
        matcher: '',
        hooks: [
          {
            type: 'http',
            url: `${base}${HOOK_MARK}g/${event}`,
            headers: { 'X-Lumen-Token': token },
            timeout:
              event === 'PermissionRequest'
                ? (opts.waitS ?? 45) + GLOBAL_PERMISSION_SLACK_S
                : NOTICE_TIMEOUT_S
          }
        ]
      }
    ]
  }
  out.hooks = hooks
  return out
}

export function hasLumenHooks(settings: Json): boolean {
  return JSON.stringify(withoutLumenHooks(settings)) !== JSON.stringify(settings)
}

function hasPermissionHook(settings: Json): boolean {
  const groups = (settings.hooks as Json | undefined)?.PermissionRequest
  return JSON.stringify(groups ?? []).includes(`${HOOK_MARK}g/`)
}

/** The port the installed global hooks point at, if any. */
export function installedPort(settings: Json): number | null {
  const m = /127\.0\.0\.1:(\d+)\/lumen-hook\//.exec(JSON.stringify(settings))
  return m ? Number(m[1]) : null
}

/** Line diff (LCS) with two lines of context around changes. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before ? before.split(/\r?\n/) : []
  const b = after ? after.split(/\r?\n/) : []
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: { op: ' ' | '-' | '+'; line: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i++] })
      j++
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1]))
      ops.push({ op: '-', line: a[i++] })
    else ops.push({ op: '+', line: b[j++] })
  }
  const keep = ops.map((_, k) =>
    ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.op !== ' ')
  )
  const out: string[] = []
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.op} ${o.line}`)
    else if (keep[k - 1]) out.push('  …')
  })
  return out.join('\n')
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readSettings(path: string): { raw: string; json: Json } {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (!raw.trim()) return { raw, json: {} }
  const v = JSON.parse(raw) as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('~/.claude/settings.json is not a JSON object')
  return { raw, json: v as Json }
}

const pretty = (j: Json): string => `${JSON.stringify(j, null, 2)}\n`

export function previewHooks(
  install: boolean,
  base: string,
  token: string,
  port: number,
  path = userSettingsPath(),
  opts: GlobalHookOptions = {}
): ClaudeHooksPreview {
  const { raw, json } = readSettings(path)
  const next = install ? withLumenHooks(json, base, token, opts) : withoutLumenHooks(json)
  const installed = hasLumenHooks(json)
  const at = installedPort(json)
  return {
    path,
    installed,
    // Against the raw file: a re-format by the write shows up too (the exact change).
    diff: lineDiff(raw, pretty(next)),
    hash: sha(raw),
    // Another port, or the PermissionRequest opt-in changed since the install.
    ...(installed &&
    ((at !== null && at !== port) || hasPermissionHook(json) !== !!opts.permissions)
      ? { stale: true }
      : {})
  }
}

/** Writes the previewed change if the file is still what the user saw. A backup is kept. */
export function applyHooks(
  install: boolean,
  hash: string,
  base: string,
  token: string,
  path = userSettingsPath(),
  opts: GlobalHookOptions = {}
): { ok: boolean; error?: string } {
  let cur: { raw: string; json: Json }
  try {
    cur = readSettings(path)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if (sha(cur.raw) !== hash)
    return { ok: false, error: 'The file changed since the preview. Look at the new diff.' }
  const next = install ? withLumenHooks(cur.json, base, token, opts) : withoutLumenHooks(cur.json)
  mkdirSync(dirname(path), { recursive: true })
  if (cur.raw) copyFileSync(path, `${path}.lumen-bak`)
  const tmp = `${path}.lumen-tmp`
  writeFileSync(tmp, pretty(next), 'utf8')
  renameSync(tmp, path)
  return { ok: true }
}
