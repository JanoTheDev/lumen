// Record my steps (07 T31): start / stop a recording, and review the draft lesson it made:
// edit the title and each spoken step, drop steps, try it once, save it or discard it.
import { useCallback, useEffect, useState } from 'react'
import type { RecordingStatus } from '@shared/channels'
import { Button, Card, IconButton, announce, icons } from '../../../ui'

type Step = { id: string; say: string; waitsFor: string }

export function RecordSteps({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [status, setStatus] = useState<RecordingStatus | null>(null)
  const [title, setTitle] = useState('')
  const [steps, setSteps] = useState<Step[]>([])
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    window.lumen
      .invoke('teach:record-status')
      .then((s) => {
        setStatus(s)
        setTitle(s.draft?.title ?? '')
        setSteps(s.draft?.steps ?? [])
      })
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  // Follow a recording (or the drafting after it) until it settles.
  useEffect(() => {
    if (status?.phase !== 'recording' && status?.phase !== 'drafting') return
    const t = setInterval(refresh, 1500)
    return () => clearInterval(t)
  }, [status?.phase, refresh])

  const say = (text: string, assertive = false): void => {
    setMsg(text)
    announce(text, assertive ? 'assertive' : 'polite')
  }

  const record = async (action: 'start' | 'stop' | 'cancel'): Promise<void> => {
    const r = await window.lumen.invoke('teach:record', action)
    if (!r.ok && r.error) say(r.error, true)
    if (r.ok && action === 'start') window.lumen.send('settings:window-minimize')
    refresh()
  }

  const save = async (): Promise<void> => {
    const res = await window.lumen.invoke('teach:draft-save', {
      title: title.trim() || 'My steps',
      steps: steps.map((s) => ({ id: s.id, say: s.say.trim() }))
    })
    if ('error' in res) return say(res.error, true)
    say(`Saved “${res.title}”`)
    onSaved()
    refresh()
  }

  const edit = (i: number, sayText: string): void =>
    setSteps((list) => list.map((s, j) => (j === i ? { ...s, say: sayText } : s)))
  const drop = (i: number): void => setSteps((list) => list.filter((_, j) => j !== i))

  const phase = status?.phase ?? 'idle'
  const valid = steps.length > 0 && steps.every((s) => s.say.trim().length >= 3)

  return (
    <Card
      title="Record my steps"
      description="Say “watch me” and a task name, or press Start, then do the task. Lumen notes what you click, select and which shortcuts you press, and writes a lesson from it. What you type is never recorded, only which box you typed in. No screenshots unless you say “take a screenshot”. A red dot stays in the bar while recording."
    >
      <div className="panel-row">
        {phase === 'recording' ? (
          <>
            <span className="ui-hint" role="status">
              ● Recording, {status?.events ?? 0} so far
            </span>
            <Button variant="primary" onClick={() => record('stop')}>
              Stop and write the lesson
            </Button>
            <Button variant="quiet" onClick={() => record('cancel')}>
              Cancel
            </Button>
          </>
        ) : phase === 'drafting' ? (
          <span className="ui-hint" role="status">
            Writing the lesson…
          </span>
        ) : (
          <Button icon={icons.mic} onClick={() => record('start')}>
            Start recording
          </Button>
        )}
      </div>

      {status?.draft && phase !== 'recording' && (
        <section aria-label="Draft lesson">
          <div className="ui-field">
            <label htmlFor="draft-title" className="ui-field__label">
              Lesson name ({status.draft.appName})
            </label>
            <input
              id="draft-title"
              className="ui-input"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <ol className="panel-list">
            {steps.map((s, i) => (
              <li key={s.id} className="panel-list__item">
                <div className="ui-field panel-list__text">
                  <label htmlFor={`draft-${s.id}`} className="ui-field__label">
                    Step {i + 1}, waits for {s.waitsFor}
                  </label>
                  <input
                    id={`draft-${s.id}`}
                    className="ui-input"
                    value={s.say}
                    maxLength={200}
                    onChange={(e) => edit(i, e.target.value)}
                  />
                </div>
                <IconButton
                  icon={icons.trash}
                  label={`Remove step ${i + 1}`}
                  variant="danger"
                  onClick={() => drop(i)}
                />
              </li>
            ))}
          </ol>
          <div className="panel-row panel-row--end">
            <Button
              icon={icons.play}
              onClick={async () => {
                await window.lumen.invoke('teach:draft-play')
                window.lumen.send('settings:window-minimize')
              }}
            >
              Try it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await window.lumen.invoke('teach:draft-discard')
                say('Draft discarded')
                refresh()
              }}
            >
              Discard
            </Button>
            <Button variant="primary" disabled={!valid} onClick={save}>
              Save lesson
            </Button>
          </div>
        </section>
      )}
      {msg && <p className="ui-hint">{msg}</p>}
    </Card>
  )
}
