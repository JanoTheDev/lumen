// What one stream-json event from the CLI means for the session view (probe 2026-10-01,
// claude-code.md): system/init, assistant (thinking / text / tool_use), user (tool_result),
// result, control_response. Pure, so the session and the tests share it.
import type { ClaudeSessionView } from '@shared/claude-code'

export interface EventEffect {
  patch: Partial<ClaudeSessionView>
  /** The turn ended (a `result` event). `costUsd` is the process total so far. */
  turnEnded?: { text: string; isError: boolean; costUsd?: number }
  controlResponse?: { requestId: string; ok: boolean }
}

const LINE_MAX = 160

type Obj = Record<string, unknown>

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function oneLine(text: string, max = LINE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** "Running npm test" / "Editing src/x.ts": the status line for a tool call. */
export function describeTool(name: string, input: Obj | undefined): string {
  const i = input ?? {}
  const file = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Running ${oneLine(str(i.command) ?? 'a command', 100)}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file ? baseName(file) : 'a file'}`
    case 'Write':
      return `Writing ${file ? baseName(file) : 'a file'}`
    case 'Read':
      return `Reading ${file ? baseName(file) : 'a file'}`
    case 'Grep':
    case 'Glob':
      return `Searching ${oneLine(str(i.pattern) ?? '', 60)}`.trim()
    case 'WebFetch':
      return `Opening ${oneLine(str(i.url) ?? 'a page', 80)}`
    case 'WebSearch':
      return `Searching the web for ${oneLine(str(i.query) ?? '', 60)}`.trim()
    case 'Task':
    case 'Agent':
      return `Starting a helper: ${oneLine(str(i.description) ?? '', 60)}`
    default:
      return `Using ${name}`
  }
}

function blocks(ev: Obj): Obj[] {
  const msg = ev.message as Obj | undefined
  const c = msg?.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? (c.filter((b) => b && typeof b === 'object') as Obj[]) : []
}

export function readEvent(ev: Obj): EventEffect {
  const type = str(ev.type)
  if (type === 'system' && ev.subtype === 'init') {
    const cmds = Array.isArray(ev.slash_commands)
      ? (ev.slash_commands.filter((c) => typeof c === 'string') as string[])
      : undefined
    return {
      patch: {
        ...(str(ev.session_id) ? { sessionId: str(ev.session_id) } : {}),
        ...(cmds ? { commands: cmds.slice(0, 300) } : {}),
        phase: 'thinking'
      }
    }
  }
  if (type === 'assistant') {
    let patch: Partial<ClaudeSessionView> = { phase: 'thinking' }
    for (const b of blocks(ev)) {
      if (b.type === 'text' && str(b.text)?.trim())
        patch = { ...patch, lastLine: oneLine(str(b.text)!) }
      if (b.type === 'tool_use')
        patch = {
          phase: 'running-tool',
          lastLine: describeTool(str(b.name) ?? 'a tool', b.input as Obj)
        }
    }
    return { patch }
  }
  if (type === 'user') {
    for (const b of blocks(ev))
      if (b.type === 'text' && /request interrupted/i.test(str(b.text) ?? ''))
        return { patch: { lastLine: 'Interrupted' } }
    return { patch: { phase: 'thinking' } }
  }
  if (type === 'result') {
    const text = str(ev.result) ?? ''
    const isError = ev.is_error === true || (str(ev.subtype) ?? 'success') !== 'success'
    const cost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined
    return {
      patch: {
        phase: 'idle',
        ...(text.trim() ? { lastAnswer: text.trim(), lastLine: oneLine(text) } : {}),
        ...(isError && !text.trim() ? { lastLine: 'Stopped' } : {})
      },
      turnEnded: { text: text.trim(), isError, ...(cost !== undefined ? { costUsd: cost } : {}) }
    }
  }
  if (type === 'control_response') {
    const r = ev.response as Obj | undefined
    const id = str(r?.request_id)
    if (id) return { patch: {}, controlResponse: { requestId: id, ok: r?.subtype === 'success' } }
  }
  return { patch: {} }
}
