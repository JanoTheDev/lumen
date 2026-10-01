// Finding the user's `claude` CLI and building its headless command line. Lumen never installs
// it and never passes --dangerously-skip-permissions or bypassPermissions.
import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import type { ClaudeCliStatus } from '@shared/claude-code'

export const INSTALL_URL = 'https://code.claude.com/docs/en/setup'

const NAME_RE = /^claude(\.exe|\.cmd)?$/i
/** Model names and aliases ("sonnet", "claude-sonnet-4-5", "opus[1m]"). */
const MODEL_RE = /^[\w.:[\]-]{1,80}$/
/** Session ids from the CLI (a uuid). */
const RESUME_RE = /^[\w-]{1,80}$/
const FLAGS_WITHOUT_VALUE = new Set(['-p', '--verbose'])

export function isClaudePath(p: string): boolean {
  return NAME_RE.test(basename(p)) && existsSync(p)
}

function whereClaude(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where.exe', ['claude'], { timeout: 4000, windowsHide: true }, (err, out) =>
      resolve(
        err
          ? []
          : String(out)
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
      )
    )
  })
}

/** Configured path, then PATH, then the native installer and npm global folders. */
export async function findClaude(configured: string, env = process.env): Promise<string | null> {
  if (configured) return isClaudePath(configured) ? configured : null
  const candidates = [
    ...(await whereClaude()),
    join(env.USERPROFILE ?? homedir(), '.local', 'bin', 'claude.exe'),
    ...(env.APPDATA ? [join(env.APPDATA, 'npm', 'claude.cmd')] : [])
  ]
  // A .exe beats a .cmd shim in the same list.
  const ok = candidates.filter(isClaudePath)
  return ok.find((p) => /\.exe$/i.test(p)) ?? ok[0] ?? null
}

export function claudeVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const c = command(path, ['--version'])
    const opts = { timeout: 8000, windowsHide: true, windowsVerbatimArguments: c.verbatim }
    execFile(c.file, c.args, opts, (err, out) =>
      resolve(err ? undefined : String(out).trim().split(/\s+/)[0] || undefined)
    )
  })
}

export async function cliStatus(configured: string): Promise<ClaudeCliStatus> {
  const path = await findClaude(configured)
  if (!path) return { found: false, installUrl: INSTALL_URL }
  return { found: true, path, version: await claudeVersion(path), installUrl: INSTALL_URL }
}

export interface ClaudeArgsInput {
  resume?: string
  model?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Per-session settings file with Lumen's http hooks. */
  settingsPath?: string
}

/** The headless, stream-json-both-ways command line (claude-code.md, probe 2026-10-01). */
export function buildArgs(input: ClaudeArgsInput): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // Every prompt the CLI would show goes to Lumen's PermissionRequest hook (autopilot policy),
    // never to the user's "auto" classifier default.
    '--permission-mode',
    'manual'
  ]
  const refuse = (a: string): never => {
    throw new Error(`refused claude argument: ${a.slice(0, 60)}`)
  }
  if (input.resume)
    args.push('--resume', RESUME_RE.test(input.resume) ? input.resume : refuse(input.resume))
  if (input.model)
    args.push('--model', MODEL_RE.test(input.model) ? input.model : refuse(input.model))
  if (input.allowedTools?.length) args.push('--allowedTools', input.allowedTools.join(','))
  if (input.disallowedTools?.length) args.push('--disallowedTools', input.disallowedTools.join(','))
  // Any absolute path, non-ASCII user names included: no shell ever parses it unquoted.
  if (input.settingsPath)
    args.push(
      '--settings',
      isAbsolute(input.settingsPath) ? input.settingsPath : refuse(input.settingsPath)
    )
  // Control characters, anything that skips permissions, a value that reads as a flag.
  for (const a of args)
    // eslint-disable-next-line no-control-regex
    if (/[\0-\x1f]/.test(a) || /bypassPermissions|dangerously/i.test(a)) refuse(a)
  for (let i = 1; i < args.length; i++)
    if (
      args[i - 1].startsWith('-') &&
      !FLAGS_WITHOUT_VALUE.has(args[i - 1]) &&
      args[i].startsWith('-')
    )
      refuse(args[i])
  return args
}

export interface SpawnCommand {
  file: string
  args: string[]
  /** Pass as spawn's windowsVerbatimArguments (the cmd.exe line is quoted here). */
  verbatim: boolean
}

/**
 * What an npm `.cmd` shim runs: the quoted `%dp0%\…\cli.js` on its `%*` line (run with the
 * shim's node.exe, else node on PATH) or `%dp0%\…\claude.exe`. null for any other shape.
 */
export function resolveShim(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = existsSync
): { file: string; pre: string[] } | null {
  let text: string
  try {
    text = read(path).slice(0, 64 * 1024)
  } catch {
    return null
  }
  const line = text.split(/\r?\n/).find((l) => l.includes('%*'))
  if (!line) return null
  const hits = [...line.matchAll(/"%~?dp0%?\\([^"%\r\n]+?\.(?:js|cjs|mjs|exe))"/gi)]
  const rel = hits.pop()?.[1]
  if (!rel) return null
  const dir = resolve(dirname(path))
  const target = resolve(dir, rel)
  if (!target.toLowerCase().startsWith(dir.toLowerCase() + sep) || !exists(target)) return null
  if (/\.exe$/i.test(target)) return { file: target, pre: [] }
  const localNode = join(dir, 'node.exe')
  return { file: exists(localNode) ? localNode : 'node', pre: [target] }
}

/** One cmd.exe argument, always quoted; refuses what cmd.exe would still expand or split. */
function cmdArg(a: string): string {
  if (/["%!^\r\n\0]/.test(a) || /\\$/.test(a))
    throw new Error(`refused claude argument for cmd.exe: ${a.slice(0, 60)}`)
  return `"${a}"`
}

/**
 * A .exe runs directly. A .cmd shim (npm global) is resolved to the program it starts, which
 * runs directly too: no shell parses the arguments and a kill reaches the real CLI. A shim of
 * another shape runs through cmd.exe with every argument quoted.
 */
export function command(path: string, args: string[]): SpawnCommand {
  if (!/\.cmd$/i.test(path)) return { file: path, args, verbatim: false }
  const direct = resolveShim(path)
  if (direct) return { file: direct.file, args: [...direct.pre, ...args], verbatim: false }
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const line = [path, ...args].map(cmdArg).join(' ')
  return { file: cmd, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}
