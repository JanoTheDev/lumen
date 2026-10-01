// Claude sessions as background tasks (08 T33 → CONTRACTS C11). The BackgroundManager runs one
// injected `run(ctl)` for every task, so a Claude session cannot be started through it yet; this
// adapter has the manager's run shape and the view → task mapping for when it takes a per-task
// runner (StartInput.run). Until then sessions show in Settings → Claude Code and by voice.
import type { BackgroundTask, BackgroundTaskPhase } from '@shared/types'
import type { ClaudeSessionView } from '@shared/claude-code'
import type { RunOutcome, TaskControl } from '../agent-mode/background/manager'

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

export function toBackgroundTask(v: ClaudeSessionView): BackgroundTask {
  const phase = taskPhase(v)
  return {
    id: v.id,
    title: `Claude: ${v.title}`,
    prompt: v.title,
    origin: 'voice',
    phase,
    progress: v.lastLine ? [v.lastLine] : [],
    counters: { modelCalls: v.turns, costUsd: v.costUsd, startedAt: v.startedAt },
    ...(v.pending ? { question: { text: v.pending.text } } : {}),
    ...(phase === 'done' || phase === 'failed'
      ? {
          endedAt: v.lastActive,
          result: { summary: v.lastAnswer ?? v.error ?? v.lastLine }
        }
      : {})
  }
}

export interface SessionPort {
  view(): ClaudeSessionView | null
  onChange(fn: (v: ClaudeSessionView) => void): () => void
  answer(text: string): void
  interrupt(): void
}

/** ManagerDeps.run for one Claude turn: progress lines, relayed questions, done at turn end. */
export function runClaudeTurn(ctl: TaskControl, port: SessionPort): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    let asking = false
    let off: () => void = () => {}
    const finish = (r: RunOutcome): void => {
      off()
      resolve(r)
    }
    const onAbort = (): void => {
      port.interrupt()
      finish({ status: 'failed', summary: 'Stopped.' })
    }
    ctl.signal.addEventListener('abort', onAbort, { once: true })
    off = port.onChange((v) => {
      if (v.lastLine) ctl.progress(v.lastLine)
      ctl.update({ counters: { ...ctl.task().counters, costUsd: v.costUsd } })
      if (v.pending?.kind === 'question' && !asking) {
        asking = true
        ctl.ask(v.pending.text).then(
          (a) => {
            asking = false
            port.answer(a)
          },
          () => (asking = false)
        )
      }
      const phase = taskPhase(v)
      if (phase === 'done' || phase === 'failed' || phase === 'cancelled') {
        ctl.signal.removeEventListener('abort', onAbort)
        finish({
          status: phase === 'done' ? 'done' : 'failed',
          summary: v.lastAnswer ?? v.error ?? v.lastLine ?? ''
        })
      }
    })
  })
}
