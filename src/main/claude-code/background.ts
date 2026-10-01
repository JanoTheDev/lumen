// Claude sessions as background tasks (08 T33/T39 → CONTRACTS C11). One task is one stretch of
// work: it starts when the session gets busy (a turn sent by voice, the bar, Settings or
// autopilot) and ends when Claude is idle again with nothing waiting for the user. The task
// brings its own runner (StartInput.run) and its own caps from the copilot settings; Claude's
// cost is shown but only capped when the user set a cap.
import type { BackgroundTask, BackgroundTaskPhase } from '@shared/types'
import type { ClaudeBarView, ClaudeSessionView } from '@shared/claude-code'
import type { RunOutcome, TaskControl } from '../agent-mode/background/manager'
import { statusLine } from './copilot'

export const BAR_LINES = 6
export const PERMISSION_CHOICES = ['Allow', 'Always allow', 'Deny'] as const

export function taskPhase(v: ClaudeSessionView): BackgroundTaskPhase {
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

/** The session is working or waiting for the user: a task should be open for it. */
export function sessionBusy(v: ClaudeSessionView): boolean {
  return taskPhase(v) === 'running' || taskPhase(v) === 'asking'
}

export function taskTitleFor(v: ClaudeSessionView): string {
  return `Claude: ${v.title}`.slice(0, 80)
}

export function toBackgroundTask(v: ClaudeSessionView): BackgroundTask {
  const phase = taskPhase(v)
  return {
    id: v.id,
    title: taskTitleFor(v),
    prompt: v.title,
    origin: 'voice',
    phase,
    progress: v.lastLine ? [v.lastLine] : [],
    counters: { modelCalls: v.turns, costUsd: v.costUsd, startedAt: v.startedAt },
    claude: { id: v.id, projectName: v.projectName, phase: v.phase },
    ...(v.pending ? { question: { text: v.pending.text } } : {}),
    ...(phase === 'done' || phase === 'failed'
      ? {
          endedAt: v.lastActive,
          result: { summary: v.lastAnswer ?? v.error ?? v.lastLine }
        }
      : {})
  }
}

/** "Allow" / "Always allow" / "Deny" (or a spoken variant) → the bridge's answer. */
export function permissionAnswer(text: string): 'once' | 'always' | 'deny' {
  const t = text.trim().toLowerCase()
  if (/^(always|allow always)/.test(t)) return 'always'
  if (/^(allow|yes|ok|okay|approve|sure|go)/.test(t)) return 'once'
  return 'deny'
}

export interface SessionPort {
  view(): ClaudeSessionView | null
  onChange(fn: (v: ClaudeSessionView) => void): () => void
  /** The user's answer to Claude's question (a new user turn). */
  answer(text: string): void
  permission(answer: 'once' | 'always' | 'deny', permId?: string): void
  interrupt(): void
}

export interface ClaudeCaps {
  /** USD for this task; 0 = no cap. */
  maxCostUsd: number
  /** 0 = no cap. */
  maxWallMs: number
}

const NO_CAPS: ClaudeCaps = { maxCostUsd: 0, maxWallMs: 0 }

function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/**
 * StartInput.run for one stretch of a Claude session: progress lines, the live phase, cost,
 * relayed questions and permissions (answered from the Tasks list or anywhere else), done once
 * Claude is idle. An idle phase is checked again a tick later: autopilot marks the session busy
 * right after a turn ends when it is about to answer, which keeps the same task open.
 */
export function runClaudeTurn(
  ctl: TaskControl,
  port: SessionPort,
  caps: ClaudeCaps = NO_CAPS,
  defer: (fn: () => void) => void = (fn) => void setTimeout(fn, 0)
): Promise<RunOutcome> {
  const first = port.view()
  const baseCost = first?.costUsd ?? 0
  const baseTurns = first?.turns ?? 0
  return new Promise<RunOutcome>((resolve) => {
    let ended = false
    let asked: string | null = null
    let checking = false
    let wall: ReturnType<typeof setTimeout> | null = null
    let off: () => void = () => {}
    const finish = (r: RunOutcome): void => {
      if (ended) return
      ended = true
      off()
      if (wall) clearTimeout(wall)
      ctl.signal.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = (): void => {
      port.interrupt()
      finish({ status: 'failed', summary: 'Stopped.' })
    }
    const capHit = (why: string): void => {
      port.interrupt()
      finish({ status: 'failed', summary: `Stopped: ${why}.` })
    }
    const settle = (v: ClaudeSessionView): void => {
      const phase = taskPhase(v)
      if (phase === 'running' || phase === 'asking') return
      const summary = v.lastAnswer ?? v.error ?? v.lastLine ?? ''
      if (phase === 'failed') finish({ status: 'failed', summary: summary || 'Claude stopped.' })
      else if (phase === 'cancelled') finish({ status: 'done', summary: 'Session closed.' })
      else finish({ status: 'done', summary: summary || 'Done.' })
    }
    const onView = (v: ClaudeSessionView): void => {
      if (ended) return
      if (v.lastLine) ctl.progress(v.lastLine)
      const cost = Math.max(0, v.costUsd - baseCost)
      ctl.update({
        counters: {
          ...ctl.task().counters,
          costUsd: cost,
          modelCalls: Math.max(0, v.turns - baseTurns)
        },
        claude: { id: v.id, projectName: v.projectName, phase: v.phase }
      })
      if (caps.maxCostUsd > 0 && cost >= caps.maxCostUsd)
        return capHit(`it reached the ${money(caps.maxCostUsd)} cap for one task`)
      const p = v.pending
      const key = p ? `${p.kind}:${p.permId ?? ''}:${p.text}` : null
      if (p && key !== asked) {
        asked = key
        const isPerm = p.kind === 'permission'
        const choices = isPerm ? [...PERMISSION_CHOICES] : (p.choices ?? []).slice(0, 4)
        ctl.ask(p.text, choices).then(
          (a) => {
            if (asked !== key) return
            asked = null
            if (isPerm) port.permission(permissionAnswer(a), p.permId)
            else port.answer(a)
          },
          () => undefined
        )
      } else if (!p && asked) {
        // Answered elsewhere (voice, the bar, Settings): the task runs on.
        asked = null
        ctl.update({ phase: 'running', question: undefined })
      }
      if (!sessionBusy(v) && !checking) {
        checking = true
        defer(() => {
          checking = false
          const now = port.view()
          if (now && !ended) settle(now)
          else if (!now) finish({ status: 'done', summary: 'Session closed.' })
        })
      }
    }
    ctl.signal.addEventListener('abort', onAbort, { once: true })
    if (caps.maxWallMs > 0)
      wall = setTimeout(
        () => capHit(`it ran longer than ${Math.round(caps.maxWallMs / 60_000)} minutes`),
        caps.maxWallMs
      )
    off = port.onChange((v) => onView(v))
    if (first) onView(first)
    else finish({ status: 'failed', summary: 'The Claude session is gone.' })
  })
}

/** Keeps the last few distinct activity lines of a session for the bar. */
export function pushLine(lines: string[], line: string, max = BAR_LINES): string[] {
  const t = line.trim()
  if (!t || lines[lines.length - 1] === t) return lines
  return [...lines, t].slice(-max)
}

export function barView(v: ClaudeSessionView, lines: string[]): ClaudeBarView {
  return {
    id: v.id,
    title: v.title,
    projectName: v.projectName,
    phase: v.phase,
    status: statusLine(v),
    lines,
    ...(v.pending ? { pending: v.pending } : {}),
    costUsd: v.costUsd
  }
}
