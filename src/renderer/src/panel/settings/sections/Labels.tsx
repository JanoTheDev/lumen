// Settings → Smart helpers → Community labels (11 T13): names for icon-only buttons that have
// none. Say "label the buttons" in an app to have them named (the AI guesses from a picture of
// each one), or "name this …" with the pointer on one. Fix or confirm the guesses here; a
// fixed label counts as checked by a person. Save labels.json to add them to an app pack.
import { useCallback, useEffect, useState } from 'react'
import type { LabelAppInfo, LabelEntryView } from '@shared/channels'
import type { HelpersConfig } from '@shared/config'
import { Button, Card, Select, Switch, TextField } from '../../../ui'

function Entries({ app, onChanged }: { app: string; onChanged: () => void }): JSX.Element {
  const [list, setList] = useState<LabelEntryView[]>([])
  const [note, setNote] = useState('')
  const load = useCallback(() => {
    window.lumen
      .invoke('labels:entries', app)
      .then((r) => setList(Array.isArray(r) ? r : []))
      .catch(() => setList([]))
  }, [app])
  useEffect(load, [load])
  const edit = (key: string, label: string | null): void => {
    void window.lumen.invoke('labels:edit', { app, key, label }).then(() => {
      load()
      onChanged()
    })
  }
  const save = (): void => {
    void window.lumen.invoke('labels:save-json', app).then((r) => {
      setNote(r.ok && r.path ? `Saved to ${r.path}` : r.error === 'cancelled' ? '' : 'Not saved.')
    })
  }
  const share = (): void => {
    void window.lumen.invoke('labels:export-lumen', app).then((r) => {
      setNote(
        r.ok && r.path
          ? `Saved to ${r.path}. They open it in Settings, Lessons, Share with someone.`
          : r.error === 'cancelled'
            ? ''
            : 'Not saved.'
      )
    })
  }
  return (
    <>
      <ul className="panel-list" aria-label="Labels">
        {list.map((l) => (
          <li key={l.key}>
            <TextField
              label={`${l.role}${l.source === 'ai' ? `, AI guess ${Math.round(l.confidence * 100)}%` : ', checked'}${l.origin === 'shared' ? ', shared with you' : ''}`}
              value={l.label}
              hint={l.description}
              accept={(v) => v.trim().length >= 2}
              commitOnBlurOnly
              onCommit={(v) => edit(l.key, v)}
            />
            {l.source === 'ai' && (
              <Button variant="quiet" onClick={() => edit(l.key, l.label)}>
                It’s right
              </Button>
            )}
            <Button
              variant="quiet"
              aria-label={`Delete label ${l.label}`}
              onClick={() => edit(l.key, null)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <Button onClick={save}>Save as labels.json</Button>
      <Button onClick={share}>Save as a .lumen file to send</Button>
      <p className="ui-hint">
        To share these with everyone, add labels.json to the app’s pack (skills/{app}/labels.json)
        in a pull request. To give them to one person, send the .lumen file.
      </p>
      {note && <p role="status">{note}</p>}
    </>
  )
}

export function Labels({
  h,
  set
}: {
  h: HelpersConfig
  set: (p: Partial<HelpersConfig>) => void
}): JSX.Element {
  const [apps, setApps] = useState<LabelAppInfo[]>([])
  const [app, setApp] = useState('')
  const load = useCallback(() => {
    window.lumen
      .invoke('labels:apps')
      .then((r) => setApps(r))
      .catch(() => setApps([]))
  }, [])
  useEffect(load, [load])
  const picked = apps.find((a) => a.app === app) ?? apps[0]
  const remove = (id: string): void => {
    void window.lumen.invoke('labels:remove-app', id).then(load)
  }
  return (
    <Card
      title="Community labels"
      description="Many apps have buttons with only an icon, so screen readers just say “button”. In such an app say “label the buttons”: Lumen sends a picture of each unnamed button to the AI and keeps the names on this PC. With the pointer on one, say “name this” and a name to set it yourself."
    >
      <Switch
        checked={h.labels}
        onChange={(labels) => set({ labels })}
        label="Use labels for unnamed buttons"
        hint="When focus lands on one, for “what’s this” and for “click” and its name."
      />
      {apps.length === 0 ? (
        <p className="ui-hint">No labels yet.</p>
      ) : (
        <>
          <Select
            label="App"
            value={picked.app}
            options={apps.map((a) => ({
              value: a.app,
              label: `${a.appName} (${a.count}, ${a.human} checked)`
            }))}
            onChange={setApp}
          />
          <Entries key={picked.app} app={picked.app} onChanged={load} />
          <Button variant="danger" onClick={() => remove(picked.app)}>
            Delete all labels for {picked.appName}
          </Button>
        </>
      )}
    </Card>
  )
}
