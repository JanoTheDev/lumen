// Settings → Lessons → Share with someone (11 T24): a helper (teacher, family member,
// caregiver) puts some of their own lessons, and the button names they made for those apps,
// into one `.lumen` file; the person they help opens it here. No account, no server.
import { useCallback, useEffect, useState } from 'react'
import type { HandoffInfo, LessonListItem } from '@shared/channels'
import { Button, Card, Switch, TextField, announce } from '../../../ui'

export function Handoff({
  mine,
  onChanged
}: {
  mine: LessonListItem[]
  onChanged: () => void
}): JSX.Element {
  const [picked, setPicked] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [from, setFrom] = useState('')
  const [note, setNote] = useState('')
  const [labels, setLabels] = useState(true)
  const [received, setReceived] = useState<HandoffInfo[]>([])
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    window.lumen
      .invoke('teach:handoff-list')
      .then(setReceived)
      .catch(() => setReceived([]))
  }, [])
  useEffect(load, [load])

  const say = (text: string): void => {
    setMsg(text)
    announce(text)
  }
  const toggle = (id: string, on: boolean): void =>
    setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)))

  const share = async (): Promise<void> => {
    const r = await window.lumen.invoke('teach:handoff-export', {
      lessonIds: picked,
      title: title.trim() || mine.find((l) => l.id === picked[0])?.title || 'Lessons',
      ...(from.trim() ? { from: from.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      includeLabels: labels
    })
    if ('error' in r && r.error === 'cancelled') return
    say(r.ok && r.path ? `Saved to ${r.path}. Send this file to them.` : `Not saved: ${r.error}`)
  }

  const open = async (): Promise<void> => {
    const r = await window.lumen.invoke('teach:handoff-install')
    if (r.error === 'cancelled') return
    if (!r.ok || !r.installed) {
      say(
        `Could not open it: ${r.error}${r.problems ? ` (${r.problems.slice(0, 3).join('; ')})` : ''}`
      )
      return
    }
    const parts = r.installed.map(
      (h) =>
        `“${h.title}”${h.from ? ` from ${h.from}` : ''}: ${h.lessons} ${h.lessons === 1 ? 'lesson' : 'lessons'}${h.labels ? `, ${h.labels} button names` : ''}`
    )
    say(`Added ${parts.join('; ')}.`)
    load()
    onChanged()
  }

  const remove = (id: string): void => {
    void window.lumen.invoke('teach:handoff-remove', id).then(() => {
      load()
      onChanged()
    })
  }

  return (
    <Card
      title="Share with someone"
      description="Helping someone learn? Record or save lessons here, then put them in a file to send by mail or USB stick. They open it in Lumen on their PC. Lessons from a file never click or type for them."
    >
      {mine.length === 0 ? (
        <p className="ui-hint">
          You have no lessons of your own yet. Say “watch me do this” to record one.
        </p>
      ) : (
        <>
          <fieldset className="panel-fieldset">
            <legend className="ui-field__label">Lessons to share</legend>
            {mine.map((l) => (
              <Switch
                key={l.id}
                checked={picked.includes(l.id)}
                onChange={(on) => toggle(l.id, on)}
                label={`${l.title} (${l.appName})`}
              />
            ))}
          </fieldset>
          <TextField
            label="Name of the file"
            value={title}
            onCommit={setTitle}
            announceSave={false}
            placeholder="Blender basics for Sam"
          />
          <TextField
            label="From"
            value={from}
            onCommit={setFrom}
            announceSave={false}
            placeholder="Your name"
          />
          <TextField
            label="Note for them"
            value={note}
            onCommit={setNote}
            announceSave={false}
            multiline
          />
          <Switch
            checked={labels}
            onChange={setLabels}
            label="Include my button names for these apps"
            hint="Community labels you made or checked."
          />
          <Button variant="primary" disabled={!picked.length} onClick={() => void share()}>
            Save file to share
          </Button>
        </>
      )}
      <Button onClick={() => void open()}>Open a file from a helper</Button>
      {msg && <p role="status">{msg}</p>}
      {received.length > 0 && (
        <ul className="panel-list" aria-label="From helpers">
          {received.map((h) => (
            <li key={h.id}>
              {h.title}
              {h.from ? `, from ${h.from}` : ''} ({h.lessons}{' '}
              {h.lessons === 1 ? 'lesson' : 'lessons'})
              {h.note && <p className="ui-hint">{h.note}</p>}
              <Button variant="quiet" aria-label={`Remove ${h.title}`} onClick={() => remove(h.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
