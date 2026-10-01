// Claude Code sessions in the task chat (08 T41): the CLI's stream-json events (the same ones
// claude-code/events.ts reads for the session view) as transcript entries. Pure.
import type { ClaudeSessionView } from '@shared/claude-code'
import type { ChatPhase } from '@shared/task-chat'
import type { ToolContent } from '../ai/providers/types'
import { describeTool } from '../claude-code/events'
import type { ChatMeta, TranscriptRecorder } from './transcript'

type Obj = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function blocks(ev: Obj): Obj[] {
  const msg = ev.message as Obj | undefined
  const c = msg?.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? (c.filter((b) => b && typeof b === 'object') as Obj[]) : []
}

function resultContent(b: Obj): ToolContent[] {
  const c = b.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  if (!Array.isArray(c)) return []
  return c
    .filter((x): x is Obj => !!x && typeof x === 'object')
    .map(
      (x): ToolContent =>
        x.type === 'text'
          ? { type: 'text', text: str(x.text) ?? '' }
          : { type: 'text', text: '[image]' }
    )
}

/** One stream-json event into the session's transcript. */
export function applyClaudeEvent(rec: TranscriptRecorder, ev: Obj): void {
  const type = str(ev.type)
  if (type === 'assistant') {
    for (const b of blocks(ev)) {
      if (b.type === 'text' && str(b.text)?.trim()) rec.assistant(str(b.text)!)
      if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool'
        const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Obj
        rec.toolStart(
          { id: str(b.id) ?? `${name}-${Date.now()}`, name, input },
          describeTool(name, input)
        )
      }
    }
    return
  }
  if (type === 'user') {
    for (const b of blocks(ev)) {
      if (b.type !== 'tool_result') continue
      rec.toolEnd(
        { id: str(b.tool_use_id) ?? '', name: '', input: {} },
        { content: resultContent(b), isError: b.is_error === true }
      )
    }
    return
  }
  if (type === 'result') {
    rec.closeOpen()
    const isError = ev.is_error === true || (str(ev.subtype) ?? 'success') !== 'success'
    if (isError) rec.error(str(ev.result)?.trim() || 'Claude stopped this turn.')
  }
}

export function claudePhase(v: ClaudeSessionView): ChatPhase {
  if (v.pending) return 'asking'
  switch (v.phase) {
    case 'starting':
    case 'thinking':
    case 'running-tool':
      return 'running'
    case 'waiting-permission':
    case 'waiting-answer':
      return 'asking'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'cancelled'
    default:
      return 'done'
  }
}

export function claudeMeta(v: ClaudeSessionView): ChatMeta {
  return {
    kind: 'claude',
    title: `Claude: ${v.title}`.slice(0, 80),
    phase: claudePhase(v),
    startedAt: v.startedAt,
    ...(claudePhase(v) === 'done' || claudePhase(v) === 'failed' ? { endedAt: v.lastActive } : {}),
    modelCalls: v.turns,
    costUsd: v.costUsd,
    project: v.projectName
  }
}

export const PERMISSION_CHOICES = ['Allow', 'Always allow', 'Deny']

/** The session's waiting permission / question as a question entry; answered once it is gone. */
export function applyClaudeView(rec: TranscriptRecorder, v: ClaudeSessionView): void {
  rec.meta = claudeMeta(v)
  const p = v.pending
  if (p) {
    const text = p.kind === 'permission' && p.command ? `${p.text}\n${p.command}` : p.text
    rec.question(text, p.kind === 'permission' ? PERMISSION_CHOICES : p.choices)
  } else if (rec.openQuestion()) rec.answer('Answered')
}

/**
 * A user turn written to the CLI. Autopilot answers go through the same pipe: one that matches
 * the session's newest automatic answer is shown as Lumen's, not the user's.
 */
export function applyClaudeUser(
  rec: TranscriptRecorder,
  text: string,
  v: ClaudeSessionView | null,
  now: number
): void {
  const auto = v?.autoAnswers[v.autoAnswers.length - 1]
  if (auto && auto.answer === text.trim() && now - auto.at < 10_000) {
    rec.answer(`Autopilot: ${auto.answer}`)
    rec.status(`Autopilot answered for you (${auto.reason})`)
    return
  }
  if (rec.openQuestion()) rec.answer(text)
  else rec.user(text)
}
