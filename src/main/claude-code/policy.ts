// Autopilot permission policy (08 T35/T36, claude-code.md "Autopilot"): what Lumen does with a
// permission prompt Claude Code would show. Pure. The hard list always asks the user with the
// exact command, at every level, and is denied when nobody is there to answer.
import { relative, resolve, sep } from 'path'
import type { AutopilotLevel } from '@shared/claude-code'
import type { Risk } from '../actions/safety'

export interface ToolRequest {
  tool: string
  input: Record<string, unknown>
  /** The session's working folder. */
  cwd: string
  /** The project root (usually = cwd). */
  project: string
}

export interface ClaudeDecision {
  verdict: 'allow' | 'ask'
  risk: Exclude<Risk, 'blocked'>
  reason: string
  /** On the hard list: never auto, never "always", denied when unattended. */
  hard?: boolean
  /** What the user is asked about: the exact command or file. */
  what: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function inside(project: string, p: string, cwd = project): boolean {
  if (!p) return true
  const full = resolve(cwd, p.replace(/^~(?=[\\/]|$)/, '/__home__'))
  const root = resolve(project)
  const a = full.toLowerCase()
  const b = root.toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function filePath(input: Record<string, unknown>): string {
  return str(input.file_path) || str(input.notebook_path) || str(input.path)
}

/** What the confirm shows: the command, the file, the URL. */
export function describeRequest(req: ToolRequest): string {
  const i = req.input
  if (req.tool === 'Bash' || req.tool === 'PowerShell') return str(i.command).trim()
  const f = filePath(i)
  if (f) return `${req.tool} ${f}`
  if (str(i.url)) return `${req.tool} ${str(i.url)}`
  return req.tool
}

// ---- the hard list ----

const CREDENTIAL_RE =
  /(^|[\\/\s"'=])(\.env(\.(?!example\b|sample\b|template\b)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.ssh[\\/]|\.aws[\\/]credentials|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials\.json|keys\.dat|\.docker[\\/]config\.json|[\w.-]+\.(pem|pfx|p12|key|keystore|jks))(?=$|[\s"'\\/;|&>)])/i

const FORCE_PUSH_RE =
  /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(\s(-f|--force(-with-lease)?(=\S+)?)\b|\s\+[\w/-]+)/i
const HISTORY_RE =
  /\bgit\b[^;&|\n]*\b(rebase\b|reset\s+--hard\b|filter-branch\b|filter-repo\b|commit\b[^;&|\n]*--amend\b|push\b[^;&|\n]*--mirror\b|reflog\s+expire\b|update-ref\s+-d\b|replace\b)/i
const PUBLISH_RE =
  /\b((npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|twine\s+upload|gem\s+push|nuget\s+push|docker\s+push|gh\s+release\s+create|vsce\s+publish|ovsx\s+publish|netlify\s+deploy|firebase\s+deploy|fly(ctl)?\s+deploy|wrangler\s+(deploy|publish)|terraform\s+apply|pulumi\s+up|kubectl\s+(apply|delete|rollout)|helm\s+(install|upgrade)|(serverless|sls)\s+deploy|eb\s+deploy|heroku\b|git\s+push\s+heroku|vercel(\s+(deploy|--prod)|\s*$)|(gcloud|az|aws)\b[^;&|\n]*\bdeploy\b|electron-builder\b[^;&|\n]*(--publish|-p)\s+always)/i
const MONEY_RE =
  /\b(stripe|paypal|purchase|checkout\s+session|domains?\s+(register|buy)|aws\s+ec2\s+run-instances|(gcloud|az|doctl)\b[^;&|\n]*\bcreate\b)/i
const MESSAGE_RE =
  /\b(gh\s+(pr\s+(create|comment|review|merge|close)|issue\s+(create|comment|close)|api\b[^;&|\n]*\/comments)|sendmail|mailx?\s|Send-MailMessage|hooks\.slack\.com|discord(app)?\.com\/api\/webhooks|api\.telegram\.org|api\.twilio\.com|sendMail\b)/i
const MCP_MESSAGE_RE = /^mcp__[^_]+.*__(send|post|reply|message|email|mail|comment|publish|tweet)/i

const RM_RE = /(^|[;&|]\s*)((sudo|xargs|env|command|exec|nohup|time)\s+)*rm\s+((-\w+\s+)*)(.+)$/
const PS_RM_RE = /\b(remove-item|rmdir|rd|del|erase)\b/i

/** Targets of `rm -r…` (or Remove-Item -Recurse / rmdir /s) that leave the project. */
function rmOutside(cmd: string, req: ToolRequest): boolean {
  // Every command position, also inside substitutions and subexpressions.
  for (const part of cmd.split(/&&|\|\||[;|&\n`(){}]|\$\(/)) {
    const p = part.trim()
    const m = RM_RE.exec(p)
    let recursive = false
    let targets: string[] = []
    if (m) {
      recursive = /-\w*[rR]|--recursive/.test(m[4] ?? '') || /\s-\w*[rR]\b/.test(p)
      targets = (m[6] ?? '').split(/\s+/).filter((t) => t && !t.startsWith('-'))
    } else if (PS_RM_RE.test(p)) {
      recursive = /-recurse\b|\/s\b/i.test(p)
      targets = p
        .split(/\s+/)
        .slice(1)
        .filter((t) => t && !t.startsWith('-') && !t.startsWith('/'))
    }
    if (!recursive) continue
    for (const raw of targets) {
      const t = raw.replace(/^["']|["']$/g, '')
      if (/^[~$%]|^\*$|^\/\*?$|^[a-z]:[\\/]?\*?$/i.test(t)) return true
      if (!inside(req.project, t, req.cwd)) return true
    }
  }
  return false
}

/** The hard-list reason, or null. */
export function hardReason(req: ToolRequest): string | null {
  const cmd = req.tool === 'Bash' || req.tool === 'PowerShell' ? str(req.input.command) : ''
  const path = filePath(req.input)
  if (CREDENTIAL_RE.test(` ${path} `) || (cmd && CREDENTIAL_RE.test(` ${cmd} `)))
    return 'it touches a credentials file'
  if (MCP_MESSAGE_RE.test(req.tool)) return 'it sends a message to other people'
  if (!cmd) return null
  if (FORCE_PUSH_RE.test(cmd)) return 'it is a force push'
  if (HISTORY_RE.test(cmd)) return 'it rewrites git history'
  if (rmOutside(cmd, req)) return 'it deletes files outside the project'
  if (PUBLISH_RE.test(cmd)) return 'it publishes or deploys'
  if (MONEY_RE.test(cmd)) return 'it may spend money'
  if (MESSAGE_RE.test(cmd)) return 'it sends a message to other people'
  return null
}

// ---- careful: what is safe enough to approve ----

const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'TodoRead',
  'ToolSearch',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'Skill'
])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// Fail closed: a command is approved only when every part matches one of the exact shapes below.
// Anything that can run, chain or redirect something else is never auto-approved: command and
// process substitution (backticks, $( ), <( )), variables, PowerShell subexpressions, script
// blocks and splatting, `;`, a single `&`, pipes into anything but a read-only filter,
// redirection, cmd.exe %VAR% expansion, line breaks.
const SHELL_META_RE = /[`$(){}<>;&|%@\r\n\0]/
const EVAL_RE = /\b(iex|invoke-expression|invoke-command|start-process)\b|\s-enc(odedcommand)?\b/i

/** Flags that write files or run another program, refused on every command. */
const WRITE_EXEC_FLAG_RE =
  /^(-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)|--?(output|outfile|out-file|outdir|out-dir|output-file|output-dir|pre|pre-glob|ext-diff|exec|upload-pack|receive-pack|config|global|system)(=.*)?)$/i

const SCRIPT_RE =
  /^(test|lint|typecheck|type-check|check|build|format|format:check|lint:fix)(:[\w:-]+)?$/
const NPX_TOOLS = new Set(['vitest', 'jest', 'eslint', 'tsc', 'prettier'])
const BIN_RE =
  /^(\.[\\/])?(node_modules[\\/]\.bin[\\/])?(vitest|jest|eslint|tsc|prettier)(\.cmd)?$/i
const GIT_READ = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'add',
  'commit'
])
const READERS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'which',
  'where',
  'tree',
  'rg',
  'grep',
  'sort',
  'uniq',
  'diff',
  'file',
  'stat',
  'du',
  'find',
  'get-childitem',
  'get-content',
  'select-string',
  'test-path',
  'get-item',
  'measure-object'
])
/** Read-only filters a safe command may pipe into. */
const FILTERS = new Set([
  'head',
  'tail',
  'wc',
  'grep',
  'sort',
  'uniq',
  'select-string',
  'select-object',
  'measure-object'
])

const unquote = (t: string): string => t.replace(/^(["'])(.*)\1$/, '$2')
const isFlag = (t: string): boolean => /^-/.test(t) || /^\/[a-z?]$/i.test(t)
/** Positional words and the values of `--flag=value`. */
const operands = (args: string[]): string[] =>
  args.flatMap((a) => (isFlag(a) ? (/^--?[\w-]+=(.+)$/.exec(a)?.slice(1) ?? []) : [a]))
const pathish = (t: string): boolean => /[\\/]|^~|^\.\.|^[a-z]:/i.test(t)

function words(part: string): string[] {
  return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote)
}

/** Tools that build, test or write: every path they are given stays in the project. */
function pathsInside(args: string[], req: ToolRequest): boolean {
  return operands(args).every((t) => !pathish(t) || inside(req.project, t, req.cwd))
}

function sortWrites(args: string[]): boolean {
  return args.some((a) => /^-[a-z]*o/i.test(a))
}

function safeSimple(w: string[], req: ToolRequest, filter: boolean): boolean {
  if (!w.length) return false
  const [head, ...args] = w
  const cmd = head.toLowerCase()
  if (args.some((a) => WRITE_EXEC_FLAG_RE.test(a))) return false
  // UNC paths reach out to other machines.
  if (args.some((a) => /^(\\\\|\/\/)/.test(a))) return false
  if (filter) {
    if (!FILTERS.has(cmd) || (cmd === 'sort' && sortWrites(args))) return false
    return cmd !== 'uniq' || operands(args).length === 0
  }
  switch (cmd) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const rest = args[0] === 'run' ? args.slice(1) : args
      return !!rest[0] && SCRIPT_RE.test(rest[0]) && pathsInside(rest.slice(1), req)
    }
    case 'npx': {
      const [tool, ...rest] = args
      if (!tool) return false
      const ok =
        NPX_TOOLS.has(tool) ||
        (tool === 'playwright' && rest[0] === 'test') ||
        (tool === 'biome' && rest[0] === 'check')
      return ok && pathsInside(rest, req)
    }
    case 'cargo':
      return /^(test|check|clippy|build|fmt)$/.test(args[0] ?? '') && pathsInside(args, req)
    case 'go':
    case 'dotnet': {
      const subs = cmd === 'go' ? /^(test|vet|build|fmt)$/ : /^(test|build)$/
      if (!subs.test(args[0] ?? '') || args.some((a) => /^-o$|^--?o(utput)?=/i.test(a)))
        return false
      return pathsInside(args, req)
    }
    case 'pytest':
    case 'mypy':
    case 'ruff':
    case 'flake8':
      return pathsInside(args, req)
    case 'black':
      return args.includes('--check') && pathsInside(args, req)
    case 'git': {
      const [sub, ...rest] = args
      if (!sub) return false
      if (GIT_READ.has(sub)) return sub !== 'commit' || !rest.includes('--amend')
      if (sub === 'branch') return rest.every(isFlag)
      if (sub === 'remote') return rest.length === 1 && rest[0] === '-v'
      if (sub === 'stash') return rest.length === 1 && rest[0] === 'list'
      if (sub === 'switch' || sub === 'checkout')
        return rest.length === 2 && rest[0] === (sub === 'switch' ? '-c' : '-b') && !isFlag(rest[1])
      return false
    }
    case 'mkdir':
    case 'cd': {
      const targets = args.filter((a) => a !== '-p')
      if (cmd === 'cd' && targets.length !== 1) return false
      return (
        targets.length > 0 && targets.every((t) => !isFlag(t) && inside(req.project, t, req.cwd))
      )
    }
  }
  if (/(^|[\\/])python3?(\.exe)?$/i.test(head))
    return args[0] === '-m' && /^(pytest|mypy|ruff)$/.test(args[1] ?? '') && pathsInside(args, req)
  if (BIN_RE.test(head)) return pathsInside(args, req)
  if (!READERS.has(cmd)) return false
  if (cmd === 'sort' && sortWrites(args)) return false
  if (cmd === 'tree' && args.some((a) => /^-o$/i.test(a))) return false
  if (cmd === 'file' && args.some((a) => /^-[a-z]*C|^--compile$/.test(a))) return false
  if (cmd === 'uniq' && operands(args).length > 1) return false
  return true
}

function safeCommand(cmd: string, req: ToolRequest): boolean {
  // Merging stderr into stdout is the one redirection that writes nothing.
  const c = cmd.replace(/(^|\s)2>&1(?=\s|$)/g, ' ').trim()
  if (!c || EVAL_RE.test(c)) return false
  return c.split('&&').every((chain) => {
    const stages = chain.split('|').map((s) => s.trim())
    // `||` or an empty stage is not a pipe into a filter.
    if (stages.some((s) => !s)) return false
    return stages.every((s, i) => !SHELL_META_RE.test(s) && safeSimple(words(s), req, i > 0))
  })
}

// Files whose contents decide what runs later (git config and hooks, Claude Code settings and
// hooks, editor tasks, direnv): an edit there is never approved on its own, even in the project.
const EXEC_CONFIG_RE =
  /(^|\/)(\.git|\.claude|\.vscode|\.idea|\.husky|\.githooks)(\/|$)|(^|\/)(\.envrc|\.gitmodules|\.npmrc|\.yarnrc(\.yml)?|\.mcp\.json)$/

/** The path is a file that configures what runs (see EXEC_CONFIG_RE). */
export function execConfigPath(project: string, p: string, cwd = project): boolean {
  const rel = relative(resolve(project), resolve(cwd, p))
  const segs = rel
    .split(/[\\/]+/)
    // Windows ignores trailing dots / spaces and reads `name:stream` as `name`; 8.3 names
    // (GIT~1) hide the long name.
    .map((x) =>
      x
        .split(':')[0]
        .replace(/[. ]+$/, '')
        .toLowerCase()
    )
  if (segs.some((x) => /~\d/.test(x))) return true
  return EXEC_CONFIG_RE.test(segs.join('/'))
}

export function decidePermission(req: ToolRequest, level: AutopilotLevel): ClaudeDecision {
  const what = describeRequest(req)
  const hard = hardReason(req)
  if (hard) return { verdict: 'ask', risk: 'high', reason: hard, hard: true, what }
  if (level === 'off') return { verdict: 'ask', risk: 'medium', reason: 'autopilot is off', what }
  if (level === 'full') return { verdict: 'allow', risk: 'medium', reason: 'autopilot full', what }
  // careful
  if (READ_TOOLS.has(req.tool))
    return { verdict: 'allow', risk: 'low', reason: 'reads and searches are fine', what }
  if (EDIT_TOOLS.has(req.tool)) {
    const p = filePath(req.input)
    if (!p || !inside(req.project, p, req.cwd))
      return { verdict: 'ask', risk: 'medium', reason: 'it writes outside the project', what }
    if (execConfigPath(req.project, p, req.cwd))
      return { verdict: 'ask', risk: 'medium', reason: 'it changes settings that run code', what }
    return { verdict: 'allow', risk: 'low', reason: 'an edit inside the project', what }
  }
  if (req.tool === 'Bash' || req.tool === 'PowerShell') {
    const cmd = str(req.input.command)
    if (safeCommand(cmd, req))
      return { verdict: 'allow', risk: 'low', reason: 'a check or read-only command', what }
    if (
      /\b(install|add|i)\b/.test(cmd) &&
      /\b(npm|pnpm|yarn|pip|cargo|winget|choco|scoop|bun)\b/.test(cmd)
    )
      return { verdict: 'ask', risk: 'medium', reason: 'it installs software', what }
    if (/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i.test(cmd))
      return { verdict: 'ask', risk: 'medium', reason: 'it uses the network', what }
    if (/\bgit\s+push\b/.test(cmd))
      return { verdict: 'ask', risk: 'medium', reason: 'it pushes', what }
    if (/\b(rm|del|erase|rmdir|remove-item|git\s+clean)\b/i.test(cmd))
      return { verdict: 'ask', risk: 'medium', reason: 'it deletes files', what }
    return { verdict: 'ask', risk: 'medium', reason: 'a command I do not know to be safe', what }
  }
  if (req.tool === 'WebFetch' || req.tool === 'WebSearch')
    return { verdict: 'ask', risk: 'medium', reason: 'it uses the network', what }
  return { verdict: 'ask', risk: 'medium', reason: `a ${req.tool} call`, what }
}
