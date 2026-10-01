// Lessons (07 T22): the lesson picker. Your own lessons (saved "show me how" lessons and old
// saved guides) and every app's lessons, each playable; plus saving the last lesson.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LessonListItem } from '@shared/channels'
import { Button, Card, IconButton, announce, icons } from '../../../ui'

function play(l: LessonListItem): void {
  window.lumen.invoke('teach:start', l.id).catch(() => {})
  window.lumen.send('settings:window-minimize')
}

function meta(l: LessonListItem): string {
  const steps = `${l.steps} ${l.steps === 1 ? 'step' : 'steps'}`
  const done = l.completed ? ` · done ${l.completed}×` : ''
  return `${l.level} · about ${l.minutes} min · ${steps}${done}`
}

export function Lessons(): JSX.Element {
  const [lessons, setLessons] = useState<LessonListItem[]>([])
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    window.lumen
      .invoke('teach:list')
      .then(setLessons)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const mine = lessons.filter((l) => l.source === 'user')
  const byApp = useMemo(() => {
    const groups = new Map<string, LessonListItem[]>()
    for (const l of lessons) {
      if (l.source !== 'pack') continue
      groups.set(l.appName, [...(groups.get(l.appName) ?? []), l])
    }
    return [...groups.entries()]
  }, [lessons])

  const save = async (): Promise<void> => {
    const res = await window.lumen.invoke('teach:save-last', name.trim())
    const text = 'error' in res ? res.error : `Saved “${res.title}”`
    setMsg(text)
    announce(text, 'error' in res ? 'assertive' : 'polite')
    if (!('error' in res)) {
      setName('')
      refresh()
    }
  }

  return (
    <>
      <Card
        title="Save the last lesson"
        description="Ask “show me how …” and Lumen makes a lesson on the spot. Save it here to play it again, or say “save this lesson”."
      >
        <div className="panel-row panel-row--end">
          <div className="ui-field">
            <label htmlFor="lesson-name" className="ui-field__label">
              Name
            </label>
            <input
              id="lesson-name"
              className="ui-input"
              value={name}
              placeholder="Change display scaling"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </div>
          <Button variant="primary" onClick={save}>
            Save lesson
          </Button>
        </div>
        {msg && <p className="ui-hint">{msg}</p>}
      </Card>

      <Card
        title="Your lessons"
        description={
          mine.length
            ? `${mine.length} saved, including your old saved guides. Say “start lesson” and a name to play one.`
            : 'Nothing saved yet.'
        }
      >
        {mine.length > 0 && (
          <ul className="panel-list">
            {mine.map((l) => (
              <li key={l.id} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">{l.title}</span>
                  <span className="ui-hint">
                    {l.appName} · {meta(l)}
                  </span>
                </div>
                <IconButton icon={icons.play} label={`Play ${l.title}`} onClick={() => play(l)} />
                <IconButton
                  icon={icons.trash}
                  label={`Delete ${l.title}`}
                  variant="danger"
                  onClick={async () => {
                    await window.lumen.invoke('teach:delete', l.id)
                    announce(`Deleted ${l.title}`)
                    refresh()
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Lessons by app"
        description="Step-by-step lessons that watch what you do. Say “teach me” and an app name to hear its list."
      >
        {byApp.map(([app, list]) => (
          <details key={app} className="panel-details">
            <summary>
              {app} ({list.length})
            </summary>
            <ul className="panel-list">
              {list.map((l) => (
                <li key={l.id} className="panel-list__item">
                  <div className="panel-list__text">
                    <span className="panel-list__title">{l.title}</span>
                    <span className="ui-hint">{meta(l)}</span>
                  </div>
                  <IconButton icon={icons.play} label={`Play ${l.title}`} onClick={() => play(l)} />
                </li>
              ))}
            </ul>
          </details>
        ))}
      </Card>
    </>
  )
}
