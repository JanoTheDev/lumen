// Agent-mode step list (08 T13): the announced plan with each step's status, the tool calls of
// a step behind a disclosure, Retry on a failed step, the countdown's "Start now" and the
// answer buttons of a question. Main owns the task; buttons only send assistant:command.
import type { AgentStepStatus, AgentTask } from '@shared/events'
import { Button, icons, type IconComponent } from '../ui'
import { send } from '../lib/ipc'
import { progressLabel } from './model'

const STATUS_ICON: Record<AgentStepStatus, IconComponent> = {
  pending: icons.minus,
  running: icons.play,
  done: icons.check,
  failed: icons.error,
  skipped: icons.minus
}

const STATUS_TEXT: Record<AgentStepStatus, string> = {
  pending: 'to do',
  running: 'in progress',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped'
}

export function StepList({ task }: { task: AgentTask }): JSX.Element {
  return (
    <div className="as-row as-steps">
      <p className="as-steps__summary">I&apos;ll {task.summary}</p>
      {task.steps.length > 0 && (
        <ol className="as-steps__list" aria-label={progressLabel(task)}>
          {task.steps.map((s) => {
            const Icon = STATUS_ICON[s.status]
            return (
              <li key={s.i} className={`as-steps__item is-${s.status}`}>
                <span className="as-steps__icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="as-steps__sr">{STATUS_TEXT[s.status]}: </span>
                {s.detail?.length ? (
                  <details className="as-steps__details">
                    <summary>{s.label}</summary>
                    <ul>
                      {s.detail.map((d, j) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <span className="as-steps__label">{s.label}</span>
                )}
                {s.status === 'failed' && task.phase !== 'running' && (
                  <Button
                    icon={icons.repeat}
                    onClick={() => send('assistant:command', { type: 'retry', step: s.i })}
                  >
                    Retry
                  </Button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {task.phase === 'countdown' && (
        <Button
          variant="primary"
          icon={icons.play}
          onClick={() => send('assistant:command', { type: 'go' })}
        >
          Start now
        </Button>
      )}
      {task.phase === 'asking' && task.question && (
        <div className="as-steps__question">
          <p>{task.question.text}</p>
          {task.question.choices?.map((c) => (
            <Button key={c} onClick={() => send('assistant:command', { type: 'answer', text: c })}>
              {c}
            </Button>
          ))}
        </div>
      )}
      {task.needsUserAction && (
        <p className="as-steps__your-turn">
          <strong>Your turn:</strong> {task.needsUserAction}
        </p>
      )}
    </div>
  )
}
