// Action audit log (safety-policy §8): ~/.ai-overlay/audit/YYYY-MM-DD.ndjson, one line per
// executed or denied action. Typed text is stored as length + SHA-256; only with
// `audit.storeTypedText` on is the text kept too, with secrets and passwords redacted. URLs
// and names go through the secret redactor. Files older than `audit.retentionDays` are pruned
// at start.
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
  if (app) out.app = app
  return out
}

function dayOf(t: string): string {
  return t.slice(0, 10)
}

/** Starts writing to `auditDir` and drops day files older than `retentionDays`. */
export function installAudit(auditDir: string, retentionDays = 30, now = Date.now()): void {
  dir = auditDir
  mkdirSync(dir, { recursive: true })
  pruneAudit(retentionDays, now)
}

/** Stops writing (tests). */
export function uninstallAudit(): void {
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
  try {
    appendFileSync(join(dir, `${dayOf(entry.t)}.ndjson`), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (e) {
    console.warn('[audit] write failed:', (e as Error).message)
  }
}

/** Entries of one day (YYYY-MM-DD), optionally one task's only. */
export function listAudit(date: string, taskId?: string): AuditEntry[] {
  if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
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

function describe(e: AuditEntry): string {
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
  const lines = last.slice(-8).map((e) => `- ${describe(e)}`)
  const more = last.length > 8 ? `\n…and ${last.length - 8} earlier steps.` : ''
  return `Here’s what I just did:\n${lines.join('\n')}${more}`
}
