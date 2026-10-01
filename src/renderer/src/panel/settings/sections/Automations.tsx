// Settings → Automations: make one from a sentence (preview, pre-approval choices, save), and the
// list (on/off, edit when / what, mouse and connector pre-approval, wake Lumen, catch up a
// missed run, last runs, run now, delete).
import { useCallback, useEffect, useState } from 'react'
import type {
  AutomationDraft,
  AutomationRun,
  AutomationsInfo,
  AutomationUpdate,
  AutomationView
} from '@shared/automations'
import { Button, Card, Field, IconButton, Switch, TextField, announce, icons } from '../../../ui'

const TIME_KINDS = new Set(['daily', 'every', 'monthly', 'once'])

const time = (ms?: number): string =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''

const has = (a: AutomationView, tool: string): boolean =>
  a.preApproved.some((s) => s.tool === tool && !s.args)

function meta(a: AutomationView): string {
  const parts = [a.triggerText]
  if (a.running) parts.push('running now')
  else if (a.enabled && a.nextRunAt) parts.push(`next ${time(a.nextRunAt)}`)
  if (!a.enabled) parts.push('off')
  if (a.lastResult) parts.push(`last run ${a.lastResult}`)
  return parts.join(' · ')
}

const RESULT: Record<AutomationRun['result'], string> = {
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped'
}

function Runs({ runs }: { runs: AutomationRun[] }): JSX.Element | null {
  if (!runs.length) return null
  return (
    <details>
      <summary>Last runs ({runs.length})</summary>
      <ul className="panel-list">
        {[...runs].reverse().map((r) => (
          <li key={`${r.at}-${r.via}`} className="panel-list__item">
            <span className="panel-list__text">
              <span className="panel-list__title">
                {RESULT[r.result]} · {time(r.at)}
              </span>
              {r.summary && <span className="ui-hint">{r.summary}</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Item({
  a,
  info,
  update,
  refresh
}: {
  a: AutomationView
  info: AutomationsInfo | null
  update: (u: AutomationUpdate, done: string) => Promise<void>
  refresh: () => void
}): JSX.Element {
  const isTime = TIME_KINDS.has(a.trigger.kind)
  const text =
    a.action.kind === 'remind'
      ? a.action.say
      : a.action.kind === 'task'
        ? a.action.prompt
        : (a.action.prompt ?? '')
  return (
    <li className="panel-list__item">
      <div className="panel-list__text">
        <span className="panel-list__title">{a.name}</span>
        <span className="ui-hint">{meta(a)}</span>
        <span className="ui-hint">It will {a.actionText}.</span>
        {a.problem && <span className="ui-hint">{a.problem}</span>}
        {a.disabledReason && !a.enabled && <span className="ui-hint">{a.disabledReason}</span>}
        <Switch
          checked={a.enabled}
          onChange={(enabled) =>
            void update({ id: a.id, enabled }, enabled ? 'Automation on' : 'Automation off')
          }
          label="On"
        />
        <details>
          <summary>Edit</summary>
          <TextField
            label="When"
            value={a.triggerText}
            hint="For example “every weekday at 9”, “every hour between 9 and 5”, “tomorrow at 8”, “when I open Excel”, “when a PDF lands in Downloads”, “when I’m back”."
            commitOnBlurOnly
            announceSave={false}
            onCommit={(trigger) => {
              if (trigger.trim() && trigger !== a.triggerText)
                void update({ id: a.id, trigger }, 'Saved')
            }}
          />
          <TextField
            label={a.action.kind === 'remind' ? 'Reminder' : 'What it does'}
            value={text}
            multiline
            commitOnBlurOnly
            announceSave={false}
            onCommit={(t) => {
              if (t.trim() && t !== text) void update({ id: a.id, text: t }, 'Saved')
            }}
          />
          {a.action.kind !== 'remind' && (
            <>
              <Switch
                checked={has(a, 'request_foreground')}
                onChange={(allowForeground) => void update({ id: a.id, allowForeground }, 'Saved')}
                label="May use the mouse and keyboard without asking"
                hint="Only while you are at the PC. Otherwise it skips steps on screen and leaves them in the Tasks list."
              />
              <Switch
                checked={has(a, 'mcp__*')}
                onChange={(allowConnectors) => void update({ id: a.id, allowConnectors }, 'Saved')}
                label="May use connected apps without asking"
                hint="Connectors can send, post or delete. Off: it skips those steps."
              />
            </>
          )}
          {isTime && (
            <>
              <Switch
                checked={!!a.wake}
                disabled={!info?.wakeSupported}
                onChange={(wake) => void update({ id: a.id, wake }, 'Saved')}
                label="Wake Lumen for this"
                hint={
                  info?.wakeSupported
                    ? 'Windows starts Lumen in the tray at that time when it is closed (while you are signed in).'
                    : 'Needs the installed Lumen (not the portable one).'
                }
              />
              <Switch
                checked={!!a.catchUp}
                onChange={(catchUp) => void update({ id: a.id, catchUp }, 'Saved')}
                label="Run once when Lumen starts if a run was missed"
              />
            </>
          )}
        </details>
        <Runs runs={a.runs ?? []} />
      </div>
      <Button
        icon={icons.play}
        onClick={async () => {
          const res = await window.lumen.invoke('automations:run-now', a.id).catch(() => null)
          announce(res?.ok ? 'Started. It shows in the Tasks list.' : 'It is already running.')
          refresh()
        }}
      >
        Run now
      </Button>
      <IconButton
        icon={icons.trash}
        variant="danger"
        label={`Delete “${a.name}”`}
        onClick={async () => {
          await window.lumen.invoke('automations:remove', a.id).catch(() => null)
          announce('Automation deleted')
          refresh()
        }}
      />
    </li>
  )
}

function NewAutomation({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<AutomationDraft | null>(null)
  const [mouse, setMouse] = useState(false)
  const [connectors, setConnectors] = useState(false)

  const preview = async (): Promise<void> => {
    if (text.trim().length < 3 || busy) return
    setBusy(true)
    setError('')
    const r = await window.lumen.invoke('automations:draft', text.trim()).catch(() => null)
    setBusy(false)
    if (!r) return setError('Something went wrong.')
    if (!r.ok) {
      setDraft(null)
      setError(r.error)
      announce(r.error)
      return
    }
    setDraft(r.draft)
    setMouse(false)
    setConnectors(false)
    announce(r.draft.summary)
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    const r = await window.lumen
      .invoke('automations:create', {
        name: draft.name,
        trigger: draft.trigger,
        action: draft.action,
        allowForeground: mouse,
        allowConnectors: connectors
      })
      .catch(() => null)
    if (!r?.ok) {
      setError(r?.error ?? 'Couldn’t save it.')
      return
    }
    announce('Automation saved')
    setDraft(null)
    setText('')
    onSaved()
  }

  return (
    <Card
      title="New automation"
      description="Say or type when and what, for example “every weekday at 9 summarize my inbox”, “when a PDF lands in Downloads, tell me its title”, or “when I open Excel, remind me to save a copy”."
    >
      <Field label="Automation" error={error || undefined}>
        {(a) => (
          <input
            {...a}
            className="ui-input"
            value={text}
            placeholder="every weekday at 9 summarize my inbox"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void preview()
            }}
          />
        )}
      </Field>
      <Button onClick={() => void preview()} disabled={busy || text.trim().length < 3}>
        {busy ? 'Reading…' : 'Preview'}
      </Button>
      {draft && (
        <div role="group" aria-label="Preview">
          <p>{draft.summary}</p>
          {draft.action.kind !== 'remind' && (
            <>
              <Switch
                checked={mouse}
                onChange={setMouse}
                label="May use the mouse and keyboard without asking"
                hint={
                  draft.wants.foreground
                    ? 'This one probably needs it. Only while you are at the PC.'
                    : 'Only while you are at the PC.'
                }
              />
              <Switch
                checked={connectors}
                onChange={setConnectors}
                label="May use connected apps without asking"
                hint={
                  draft.wants.connectors
                    ? 'This one probably needs it (send, post, mail).'
                    : 'Connectors can send, post or delete.'
                }
              />
            </>
          )}
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
          <Button onClick={() => setDraft(null)}>Discard</Button>
        </div>
      )}
    </Card>
  )
}

export function Automations(): JSX.Element {
  const [list, setList] = useState<AutomationView[] | null>(null)
  const [info, setInfo] = useState<AutomationsInfo | null>(null)

  const refresh = useCallback(() => {
    window.lumen
      .invoke('automations:list')
      .then((l) => setList(Array.isArray(l) ? l : []))
      .catch(() => setList([]))
  }, [])
  useEffect(refresh, [refresh])
  useEffect(() => {
    window.lumen
      .invoke('automations:info')
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const update = async (u: AutomationUpdate, done: string): Promise<void> => {
    const r = await window.lumen.invoke('automations:update', u).catch(() => null)
    announce(r?.ok ? done : (r?.error ?? 'Couldn’t change that automation.'))
    refresh()
  }

  return (
    <>
      <NewAutomation onSaved={refresh} />
      <Card
        title="Automations"
        description="They run in the background while Lumen is open (or wake it, if you turn that on). When you are away nothing is spoken and nothing uses the mouse; results wait in the Tasks list."
      >
        {list === null ? (
          <p className="ui-hint">Loading…</p>
        ) : !list.length ? (
          <p className="ui-hint">No automations yet.</p>
        ) : (
          <ul className="panel-list">
            {list.map((a) => (
              <Item key={a.id} a={a} info={info} update={update} refresh={refresh} />
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
