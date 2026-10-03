// Action audit log (safety-policy §8): ~/.ai-overlay/audit/YYYY-MM-DD.ndjson, one line per
// executed or denied action. Typed text is stored as length + SHA-256; only with
// `audit.storeTypedText` on is the text kept too, with secrets and passwords redacted. URLs
// and names go through the secret redactor. Files older than `audit.retentionDays` are pruned
// at start. Lines are queued and appended every 200 ms, at once for high-risk actions, before
// a read and on exit.
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { EvalAction, Origin, Risk } from '../actions/safety'
import { redactForLog } from '../actions/redact'

export type AuditDecision =
  /** Low risk, or medium with no confirm needed. */
  | 'auto'
  /** A stored "always" grant covered it. */
  | 'granted'
  /** The user's own batch confirm (or explain-before-do yes) covered it. */
  | 'preapproved'
  | 'confirmed-by-user'
  | 'always-by-user'
  | 'denied-by-user'
  | 'blocked'

export type AuditResult = 'ok' | 'error' | 'cancelled' | 'denied'

export interface AuditEntry {
  t: string
  task: string
  origin: Origin
  /** A buddy's run (08 T50). */
  buddyId?: string
  action: Record<string, unknown>
  risk: Risk
  decision: AuditDecision
  result: AuditResult
  ms: number
  reason?: string
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/
const DAY_MS = 86_400_000

let dir: string | null = null
let last: AuditEntry[] = []
let storeTypedText = false
let queue = new Map<string, string[]>()
let timer: ReturnType<typeof setTimeout> | null = null
let exitHooked = false
const FLUSH_MS = 200

/** `audit.storeTypedText`: keep typed text (redacted) next to its hash. Off by default. */
export function setAuditStoreTypedText(on: boolean): void {
  storeTypedText = on
}

const TYPED_TEXT_MAX = 500

/** Typed text as the log keeps it: length + hash, plus the redacted text when opted in. */
function typedText(text: string): Record<string, unknown> {
  const h = hashText(text)
  return storeTypedText ? { ...h, redacted: redactForLog(text).slice(0, TYPED_TEXT_MAX) } : h
}

export function hashText(text: string): { len: number; sha256: string } {
  return { len: text.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') }
}

const ARG_MAX = 80
const ARGS_MAX = 300

/**
 * Tool arguments in one short line for the confirm card and the audit log: secrets redacted,
 * each value cut at 80 characters, the whole at 300.
 */
export function summarizeArgs(args: Record<string, unknown>, max = ARGS_MAX): string {
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const value = (v: unknown): string => {
    const raw = typeof v === 'string' ? `“${v}”` : (JSON.stringify(v) ?? String(v))
    return cut(redactForLog(raw).replace(/\s+/g, ' ').trim(), ARG_MAX)
  }
  const line = Object.entries(args)
    .map(([k, v]) => `${k}: ${value(v)}`)
    .join(', ')
  return cut(line, max)
}

/** What the log keeps of an action: type, target, keys, URL; text only as hash + length. */
export function summarizeAction(a: EvalAction, app?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { type: a.type }
  const name =
    a.elementName ?? a.description ?? a.target?.text ?? (a.type === 'type' ? undefined : a.text)
  if (name) out.element = redactForLog(name).slice(0, 120)
  if (a.url) out.url = redactForLog(a.url).slice(0, 500)
  if (a.keys) out.keys = Array.isArray(a.keys) ? a.keys.join('+') : a.keys
  if (a.type === 'type' && a.text) out.text = typedText(a.text)
  if (a.value) out.value = typedText(a.value)
  if (a.action) out.pattern = a.action
  if (a.steps)
    out.steps = a.steps.map((s) =>
      s.t === 'type' ? { t: 'type', text: typedText(s.text) } : s.t === 'keys' ? s : { t: s.t }
    )
  if (a.appId) out.appId = a.appId
  if (a.server) out.tool = `${a.server}/${a.tool ?? ''}`
  if (a.args) {
    const json = JSON.stringify(a.args) ?? ''
    out.args = { summary: summarizeArgs(a.args), ...hashText(json) }
  }
  if (app) out.app = app
  return out
}

function dayOf(t: string): string {
  return t.slice(0, 10)
}

/** Starts writing to `auditDir` and drops day files older than `retentionDays`. */
export function installAudit(auditDir: string, retentionDays = 30, now = Date.now()): void {
  flushAudit()
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', flushAudit)
  }
  dir = auditDir
  mkdirSync(dir, { recursive: true })
  pruneAudit(retentionDays, now)
}

/** Stops writing (tests). */
export function uninstallAudit(): void {
  flushAudit()
  dir = null
  last = []
}

export function pruneAudit(retentionDays: number, now = Date.now()): number {
  if (!dir || !existsSync(dir)) return 0
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10)
  let removed = 0
  for (const name of readdirSync(dir)) {
    const m = DAY_FILE_RE.exec(name)
    if (m && m[1] < cutoff) {
      rmSync(join(dir, name), { force: true })
      removed++
    }
  }
  return removed
}

/** One line per executed or denied action. Never throws: a full disk must not stop actions. */
export function writeAudit(entry: AuditEntry): void {
  if (last.length && last[last.length - 1].task !== entry.task) last = []
  last.push(entry)
  if (!dir) return
  const file = join(dir, `${dayOf(entry.t)}.ndjson`)
  const line = `${JSON.stringify(entry)}\n`
  const lines = queue.get(file)
  if (lines) lines.push(line)
  else queue.set(file, [line])
  if (entry.risk === 'high') flushAudit()
  else if (!timer) {
    timer = setTimeout(flushAudit, FLUSH_MS)
    timer.unref?.()
  }
}

/** Appends every queued line now. Never throws. */
export function flushAudit(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!queue.size) return
  const pending = queue
  queue = new Map()
  for (const [file, lines] of pending) {
    try {
      appendFileSync(file, lines.join(''), 'utf8')
    } catch (e) {
      console.warn('[audit] write failed:', (e as Error).message)
    }
  }
}

/** Entries of one day (YYYY-MM-DD), optionally one task's only. */
export function listAudit(date: string, taskId?: string): AuditEntry[] {
  if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  flushAudit()
  const file = join(dir, `${date}.ndjson`)
  if (!existsSync(file)) return []
  const out: AuditEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as AuditEntry
      if (!taskId || e.task === taskId) out.push(e)
    } catch {
      /* a torn last line from a crash */
    }
  }
  return out
}

/** One action in plain words ("clicked “Reply”", "typed 12 characters"). */
export function describeAuditEntry(e: AuditEntry): string {
  const a = e.action
  const what =
    a.type === 'type'
      ? `typed ${(a.text as { len?: number } | undefined)?.len ?? 0} characters`
      : a.type === 'hotkey'
        ? `pressed ${String(a.keys)}`
        : a.url
          ? `opened ${String(a.url)}`
          : a.element
            ? `${String(a.type).replace(/_/g, ' ')} “${String(a.element)}”`
            : String(a.type).replace(/_/g, ' ')
  if (e.result === 'denied')
    return `${what}: not done (${e.decision === 'blocked' ? `blocked, ${e.reason ?? ''}` : 'you said no'})`
  if (e.result !== 'ok') return `${what}: ${e.result}`
  return what
}

/** "What did you just do?": the last task's actions in plain words. */
export function lastTaskSummary(): string {
  if (!last.length) return 'I haven’t done anything on your computer yet.'
  const lines = last.slice(-8).map((e) => `- ${describeAuditEntry(e)}`)
  const more = last.length > 8 ? `\n…and ${last.length - 8} earlier steps.` : ''
  return `Here’s what I just did:\n${lines.join('\n')}${more}`
}
