// Home flyout Tasks list (08 T29): background tasks with their progress line, cancel, run
// again, and answers to queued questions. A row opens the task's chat view (08 T43) in the
// panel window; "All tasks" opens the view's list.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { BackgroundTask } from '@shared/types'
import { Button, IconButton, icons } from '../../ui'
import { invoke, send, useIpc } from '../../lib/ipc'
import { taskRows, type TaskRow } from './tasks-view'

function useTasks(): [BackgroundTask[], () => void] {
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const refresh = useCallback((): void => {
    invoke('tasks:list')
      .then((list) => Array.isArray(list) && setTasks(list))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useIpc('home:shown', refresh)
  useIpc('tasks:changed', setTasks)
  return [tasks, refresh]
}

function Question({ row }: { row: TaskRow }): JSX.Element | null {
  const [draft, setDraft] = useState('')
  if (!row.question) return null
  const answer = (text: string): void => {
    if (text.trim()) void invoke('tasks:answer', row.id, text.trim()).catch(() => {})
  }
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    answer(draft)
    setDraft('')
  }
  return (
    <div className="home-task__question">
      <p>{row.question.text}</p>
      {row.question.choices.length > 0 ? (
        <div className="home-task__choices">
          {row.question.choices.map((c) => (
            <Button key={c} onClick={() => answer(c)}>
              {c}
            </Button>
          ))}
        </div>
      ) : (
        <form className="home-task__answer" onSubmit={submit}>
          <input
            className="ui-input"
            type="text"
            aria-label={`Answer for ${row.title}`}
            placeholder="Your answer…"
            maxLength={500}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <IconButton
            icon={icons.play}
            label="Send answer"
            type="submit"
            disabled={!draft.trim()}
          />
        </form>
      )}
    </div>
  )
}

export function Tasks(): JSX.Element | null {
  const [tasks] = useTasks()
  const rows = taskRows(tasks)
  if (!rows.length) return null
  return (
    <section className="home-section" aria-labelledby="home-tasks">
      <div className="home-tasks__head">
        <h2 id="home-tasks" className="home-label">
          Tasks
        </h2>
        <Button variant="quiet" onClick={() => void invoke('tasks:open', 'all').catch(() => {})}>
          All tasks
        </Button>
      </div>
      <ul className="home-tasks">
        {rows.map((r) => (
          <li key={r.id} className={`home-task is-${r.phase}${r.unseen ? ' is-unseen' : ''}`}>
            <div className="home-task__row">
              <button
                type="button"
                className="home-task__main"
                disabled={!r.canOpen}
                onClick={() => {
                  void invoke('tasks:open', r.id).catch(() => {})
                  send('panel:close')
                }}
              >
                <span className="home-task__title">{r.title}</span>
                <span className="home-task__status" aria-live="polite">
                  {r.status}
                </span>
              </button>
              {r.canCancel && (
                <IconButton
                  icon={r.claude ? icons.square : icons.close}
                  label={`${r.claude ? 'Stop' : 'Cancel'} ${r.title}`}
                  onClick={() => void invoke('tasks:cancel', r.id).catch(() => {})}
                />
              )}
              {r.canRunAgain && (
                <IconButton
                  icon={icons.repeat}
                  label={`Run again: ${r.title}`}
                  onClick={() => void invoke('tasks:run-again', r.id).catch(() => {})}
                />
              )}
            </div>
            {r.cardsId && (
              <Button
                variant="quiet"
                onClick={() => {
                  const id = r.cardsId ?? ''
                  void invoke('cards:action', { id, action: 'show-all' }).catch(() => {})
                  send('panel:close')
                }}
              >
                View results
              </Button>
            )}
            <Question row={r} />
          </li>
        ))}
      </ul>
    </section>
  )
}
