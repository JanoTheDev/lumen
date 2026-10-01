// "Dictate to Claude" (04 T42): on the dictation hotkey, "to Claude, fix the failing test in
// at file pipeline dot ts" sends the rest, cleaned up and in coding mode, to the focused
// Claude Code copilot session instead of typing it. Only while a session is focused and the
// foreground is a terminal, a code editor or Lumen itself: in a mail to someone named Claude
// the words are typed. The copilot module loads lazily.
import { basename } from 'path'
import type { FileResolver } from './coding'
import { projectResolver } from './file-resolve'
import { isCodeProcess } from './styles'
import { isTerminalTarget, type FocusTarget } from './terminal-guard'

const CLAUDE_RE =
  /^\s*(?:dictate\s+|send\s+(?:this\s+)?|type\s+)?(?:to|for)\s+claude(?:\s+code)?\s*[,:.-]?\s+([\s\S]+)$/i

/** The text after "to Claude, …" / "dictate to Claude …", else null. Pure. */
export function matchClaudeDictation(text: string): string | null {
  const m = CLAUDE_RE.exec(text)
  const body = m?.[1].trim()
  return body ? body : null
}

/**
 * True when "to Claude, …" may go to the session: one is focused, and the foreground is a
 * terminal, a code editor (by process, never a browser tab) or Lumen's own window. Pure.
 */
export function claudeTargetAllowed(
  target: Pick<FocusTarget, 'process' | 'title' | 'name'>,
  ctx: { sessionFocused: boolean; ownProcess: string }
): boolean {
  if (!ctx.sessionFocused) return false
  const proc = target.process.toLowerCase()
  if (proc && proc === ctx.ownProcess.toLowerCase()) return true
  return isTerminalTarget(target) || isCodeProcess(proc)
}

type ClaudeModule = typeof import('../../claude-code')

async function claude(): Promise<ClaudeModule | null> {
  try {
    return await import('../../claude-code')
  } catch {
    return null
  }
}

/** File resolver for the focused Claude session's project. */
export async function claudeResolver(): Promise<FileResolver | undefined> {
  return projectResolver((await claude())?.focusedProject())
}

/** File resolver for the project an editor window shows (by folder name in its title). */
export async function titleResolver(title: string): Promise<FileResolver | undefined> {
  if (!title) return undefined
  const mod = await claude()
  try {
    return projectResolver(mod?.projectForTitle(title))
  } catch {
    return undefined
  }
}

/** Whether this dictation target may receive "to Claude, …" (see claudeTargetAllowed). */
export async function claudeTargetReady(target: FocusTarget): Promise<boolean> {
  const mod = await claude()
  let sessionFocused = false
  try {
    sessionFocused = !!mod?.focusedProject()
  } catch {
    sessionFocused = false
  }
  return claudeTargetAllowed(target, {
    sessionFocused,
    ownProcess: basename(process.execPath)
  })
}

export async function sendToClaude(text: string): Promise<{ ok: boolean; notice: string }> {
  const mod = await claude()
  if (!mod) return { ok: false, notice: 'Claude Code is not available.' }
  return mod.sendDictation(text)
}
