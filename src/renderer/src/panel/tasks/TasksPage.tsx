// Task chat view (08 T43), panel route #/tasks/<id>: the list of task chats on the side
// (background tasks, on-screen agent tasks, Claude Code sessions) and the chosen one's chat.
import { useCallback, useEffect, useState } from 'react'
import type { ChatSummary } from '@shared/task-chat'
import { icons } from '../../ui'
import { invoke, useIpc } from '../../lib/ipc'
import { ChatPane } from './ChatPane'
import { summaryStatus } from './chat-view'

function useChats(): ChatSummary[] {
  const [list, setList] = useState<ChatSummary[]>([])
  const refresh = useCallback((): void => {
    invoke('tasks:chats')
      .then((l) => Array.isArray(l) && setList(l))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  // The Tasks list changes with every task; the chat list follows it.
  useIpc('tasks:changed', refresh)
  useIpc('tasks:chat-delta', (d) => {
    if (d.header) refresh()
  })
  return list
}

export function TasksPage({ id }: { id?: string }): JSX.Element {
  const list = useChats()
  return (
    <div className="panel">
      <header className="panel-titlebar">
        <span className="panel-titlebar__title">Lumen tasks</span>
        <span className="panel-titlebar__controls">
          <button
            type="button"
            aria-label="Minimize"
            onClick={() => window.lumen.send('settings:window-minimize')}
          >
            <icons.minus />
          </button>
          <button
            type="button"
            aria-label="Maximize"
            onClick={() => window.lumen.send('settings:window-maximize')}
          >
            <icons.square />
          </button>
          <button
            type="button"
            aria-label="Close"
            className="is-close"
            onClick={() => window.lumen.send('settings:window-close')}
          >
            <icons.close />
          </button>
        </span>
      </header>
      <div className="panel-body">
        <aside className="panel-side">
          <nav aria-label="Tasks" className="ui-nav chat-list">
            {list.length ? (
              <ul>
                {list.map((c) => (
                  <li key={c.id}>
                    <a
                      href={`#/tasks/${c.id}`}
                      className={`ui-nav__item chat-list__item is-${c.phase}${c.unseen ? ' is-unseen' : ''}`}
                      aria-current={c.id === id ? 'page' : undefined}
                    >
                      <span className="chat-list__title">{c.title}</span>
                      <span className="chat-list__status">{summaryStatus(c)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ui-hint">No tasks yet. Say “in the background, …” to start one.</p>
            )}
          </nav>
          <a className="ui-hint chat-list__settings" href="#/settings/background">
            Automations settings
          </a>
        </aside>
        <main className="panel-main chat-main" aria-label="Task chat">
          {id ? (
            <ChatPane key={id} id={id} />
          ) : (
            <div className="chat-empty">
              <h1>Tasks</h1>
              <p className="ui-hint">Pick a task to see what it is doing.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
