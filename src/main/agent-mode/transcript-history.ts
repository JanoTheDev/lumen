// Claude Code session history in the task chat (08 T43): a session's chat opened with nothing
// recorded yet (a session Lumen resumed, or one recorded before Lumen ran) shows what the CLI
// already wrote to ~/.claude/projects/<project>/<session>.jsonl. Read-only, only the newest
// part of the file, and everything goes through the recorder (redaction, size caps).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'fs'
import { join } from 'path'
import { claudeHome } from '../claude-code/projects'
import { applyClaudeEvent } from './transcript-claude'
import type { TranscriptRecorder } from './transcript'

/** Only the end of a long session is read. */
export const HISTORY_BYTES = 1024 * 1024

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** Claude Code's folder name for a project path: every other character becomes "-". */
export function projectDirName(project: string): string {
  return project.replace(/[^A-Za-z0-9]/g, '-')
}

/** The session's .jsonl file: in its project's folder, else in any project folder. */
export function findSessionFile(
  sessionId: string,
  project: string,
  root = join(claudeHome(), 'projects')
): string | null {
  if (!SESSION_RE.test(sessionId)) return null
  const name = `${sessionId}.jsonl`
  const first = join(root, projectDirName(project), name)
  if (existsSync(first)) return first
  try {
    for (const dir of readdirSync(root)) {
      const f = join(root, dir, name)
      if (existsSync(f)) return f
    }
  } catch {
    /* no projects folder */
  }
  return null
}

/** The last `max` bytes of a file, from the first whole line. */
export function readTail(file: string, max = HISTORY_BYTES): string {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - max)
    const buf = Buffer.alloc(size - start)
    const n = readSync(fd, buf, 0, buf.length, start)
    const text = buf.subarray(0, n).toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

type Obj = Record<string, unknown>

/** Lines Claude Code writes for itself (slash command echoes, hook output, caveats). */
const OWN_TEXT_RE = /^\s*(<command-|<local-command-|<system-reminder>|Caveat:)/

function userText(msg: Obj | undefined): string | null {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return null
  const texts = c
    .filter((b): b is Obj => !!b && typeof b === 'object' && (b as Obj).type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
  return texts.length ? texts.join('\n') : null
}

/** The session file's turns into the recorder: the user's words, Claude's text and tools. */
export function loadClaudeHistory(rec: TranscriptRecorder, jsonl: string): number {
  const before = rec.entries.length
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let ev: Obj
    try {
      ev = JSON.parse(line) as Obj
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object' || ev.isSidechain === true || ev.isMeta === true) continue
    if (ev.type === 'assistant') applyClaudeEvent(rec, ev)
    else if (ev.type === 'user') {
      const text = userText(ev.message as Obj | undefined)
      if (text !== null) {
        if (text.trim() && !OWN_TEXT_RE.test(text)) rec.user(text)
      } else applyClaudeEvent(rec, ev)
    }
  }
  rec.closeOpen()
  const added = rec.entries.length - before
  if (added) rec.status('Earlier turns, from Claude Code’s own history.')
  return added
}
