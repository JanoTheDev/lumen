// Finding the user's `claude` CLI and building its headless command line. Lumen never installs
// it and never passes --dangerously-skip-permissions or bypassPermissions.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { ClaudeCliStatus } from '@shared/claude-code'

export const INSTALL_URL = 'https://code.claude.com/docs/en/setup'

const NAME_RE = /^claude(\.exe|\.cmd)?$/i
// Flags and rule lists only; prompts go over stdin. Shell metacharacters are refused so a .cmd
// shim (run through cmd.exe) cannot be tricked.
const SAFE_ARG_RE = /^[\w:*().,/\\ \-@~="'[\]{}+#]*$/

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
  if (input.resume) args.push('--resume', input.resume)
  if (input.model) args.push('--model', input.model)
  if (input.allowedTools?.length) args.push('--allowedTools', input.allowedTools.join(','))
  if (input.disallowedTools?.length) args.push('--disallowedTools', input.disallowedTools.join(','))
  if (input.settingsPath) args.push('--settings', input.settingsPath)
  for (const a of args)
    if (!SAFE_ARG_RE.test(a) || /bypassPermissions|dangerously/i.test(a))
      throw new Error(`refused claude argument: ${a.slice(0, 60)}`)
  return args
}

export interface SpawnCommand {
  file: string
  args: string[]
  /** Pass as spawn's windowsVerbatimArguments (the cmd.exe line is quoted here). */
  verbatim: boolean
}

/** A .cmd shim (npm global) runs through cmd.exe; a .exe runs directly. */
export function command(path: string, args: string[]): SpawnCommand {
  if (!/\.cmd$/i.test(path)) return { file: path, args, verbatim: false }
  const quoted = [path, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${quoted.join(' ')}"`], verbatim: true }
}
