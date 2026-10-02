// One buddy's page in Settings → Buddies (08 T53): on/off, run now, stop, its details (edited
// and saved together, wider permissions marked), schedules, notebook, run history with task
// chat links, this month's cost, export and delete.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuddyRunSummary } from '@shared/buddies'
import type { BuddyDetail, BuddyEditable } from '@shared/buddy-views'
import type { UsageReport } from '@shared/usage'
import { Button, Card, IconButton, Switch, announce, icons } from '../../../ui'
import { useIpc } from '../../../lib/ipc'
import { BuddiesAvatar } from './BuddiesAvatar'
import { WhenField } from './BuddiesCompose'
import { BuddiesFields } from './BuddiesFields'
import {
  changedFields,
  editableOf,
  formProblems,
  monthLine,
  monthSpend,
  nextRunLine,
  runLine
} from './buddies-view'

const NOTEBOOK_MAX = 8 * 1024

function useBuddy(id: string): {
  detail: BuddyDetail | null | undefined
  runs: BuddyRunSummary[]
  report: UsageReport | null
  refresh: () => void
} {
  const [detail, setDetail] = useState<BuddyDetail | null | undefined>(undefined)
  const [runs, setRuns] = useState<BuddyRunSummary[]>([])
  const [report, setReport] = useState<UsageReport | null>(null)
  const refresh = useCallback((): void => {
    window.lumen
      .invoke('buddies:get', id)
      .then((d) => setDetail(d && 'buddy' in d ? d : null))
      .catch(() => setDetail(null))
    window.lumen
      .invoke('buddies:runs', id)
      .then((r) => Array.isArray(r) && setRuns(r))
      .catch(() => {})
  }, [id])
  const refreshCost = useCallback((): void => {
    window.lumen
      .invoke('usage:report', { range: 'month' })
      .then((r) => r && 'tables' in r && setReport(r))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useEffect(refreshCost, [refreshCost])
  useIpc('buddies:changed', (ids) => {
    if (ids.includes(id)) refresh()
  })
  useIpc('usage:changed', refreshCost)
  return { detail, runs, report, refresh }
}

function Notebook({ id, name }: { id: string; name: string }): JSX.Element {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    window.lumen
      .invoke('buddies:notebook-get', id)
      .then((t) => {
        if (typeof t !== 'string') return
        setText(t)
        setSaved(t)
      })
      .catch(() => {})
  }, [id])
  const bytes = new TextEncoder().encode(text).length
  const save = async (): Promise<void> => {
    const r = await window.lumen.invoke('buddies:notebook-set', { id, text }).catch(() => null)
    if (r?.ok) {
      setSaved(text)
      setMsg('Notebook saved.')
      announce('Notebook saved')
    } else {
      const why = r?.error ?? 'something went wrong'
      setMsg(`Not saved: ${why}`)
      announce(`Not saved: ${why}`, 'assertive')
    }
  }
  return (
    <Card
      title="Notebook"
      description={`What ${name} remembers between runs. It writes here itself; you can fix or clear it.`}
    >
      <div className="ui-field">
        <label htmlFor={`bd-notebook-${id}`} className="ui-field__label">
          Notes
        </label>
        <textarea
          id={`bd-notebook-${id}`}
          className="ui-input ui-input--multi"
          rows={6}
          aria-describedby={`bd-notebook-${id}-size`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span id={`bd-notebook-${id}-size`} className="ui-hint">
          {(bytes / 1024).toFixed(1)} of 8 KB
          {bytes > NOTEBOOK_MAX ? ': too long to save' : ''}
        </span>
      </div>
      <div className="panel-row">
        <Button disabled={text === saved || bytes > NOTEBOOK_MAX} onClick={save}>
          Save notebook
        </Button>
      </div>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
    </Card>
  )
}

function Schedules({
  detail,
  onChanged
}: {
  detail: BuddyDetail
  onChanged: () => void
}): JSX.Element {
  const { buddy, schedules } = detail
  const [when, setWhen] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const add = async (): Promise<void> => {
    setBusy(true)
    const r = await window.lumen
      .invoke('buddies:schedule-add', { id: buddy.id, when: when.trim() })
      .catch(() => null)
    setBusy(false)
    if (r?.ok) {
      setWhen('')
      setMsg('Schedule added.')
      announce('Schedule added')
      onChanged()
    } else {
      const why = r?.error ?? 'something went wrong'
      setMsg(`Not added: ${why}`)
      announce(`Not added: ${why}`, 'assertive')
    }
  }
  const remove = async (automationId: string, text: string): Promise<void> => {
    const r = await window.lumen
      .invoke('buddies:schedule-remove', { id: buddy.id, automationId })
      .catch(() => null)
    announce(r?.ok ? `Removed ${text}` : 'Not removed', r?.ok ? 'polite' : 'assertive')
    onChanged()
  }
  return (
    <Card title="Schedules" description={`When ${buddy.name} runs by itself.`}>
      {schedules.length ? (
        <ul className="panel-list">
          {schedules.map((s) => (
            <li key={s.automationId} className="panel-list__item">
              <div className="panel-list__text">
                <span className="panel-list__title">{s.triggerText}</span>
                <span className="ui-hint">
                  {[
                    s.enabled ? nextRunLine(s.nextRunAt) : 'Off',
                    s.wake ? 'wakes Lumen' : '',
                    s.prompt ? `“${s.prompt}”` : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <IconButton
                icon={icons.trash}
                label={`Remove schedule ${s.triggerText}`}
                variant="danger"
                onClick={() => void remove(s.automationId, s.triggerText)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="ui-hint">No schedules: it runs only when you ask.</p>
      )}
      <div className="panel-row panel-row--end">
        <WhenField
          label="Add a schedule"
          hint="Like “every weekday at 8” or “when I log in”."
          value={when}
          onChange={setWhen}
        />
        <Button busy={busy} disabled={busy || when.trim().length < 2} onClick={add}>
          Add
        </Button>
      </div>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
      <p className="ui-hint">To wake Lumen for a schedule, use Settings → Automations.</p>
    </Card>
  )
}

function Runs({ runs }: { runs: BuddyRunSummary[] }): JSX.Element {
  return (
    <Card title="Runs" description="Open a run to see what it did, step by step.">
      {runs.length ? (
        <ul className="panel-list">
          {runs.map((r) => (
            <li key={r.taskId} className="panel-list__item">
              <div className="panel-list__text">
                <a className="bd-run__link" href={`#/tasks/${r.taskId}`}>
                  {r.title}
                </a>
                <span className="ui-hint">{runLine(r)}</span>
                {r.summary && <span className="ui-hint bd-run__summary">{r.summary}</span>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ui-hint">No runs yet.</p>
      )}
    </Card>
  )
}

export function BuddiesDetail({ id, onBack }: { id: string; onBack: () => void }): JSX.Element {
  const { detail, runs, report, refresh } = useBuddy(id)
  // Unsaved edits; null shows the saved buddy (also after it changed elsewhere).
  const [edit, setEdit] = useState<BuddyEditable | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const headRef = useRef<HTMLHeadingElement>(null)
  const saved = detail ? editableOf(detail.buddy) : null
  const form = edit ?? saved
  const changes = edit && saved ? changedFields(edit, saved) : {}
  const dirty = Object.keys(changes).length > 0
  const loaded = !!detail

  useEffect(() => {
    if (loaded) headRef.current?.focus()
  }, [id, loaded])

  if (detail === undefined) return <p className="ui-hint">Loading…</p>
  if (!detail || !form || !saved)
    return (
      <>
        <p className="ui-hint">This buddy is gone.</p>
        <Button icon={icons.arrowLeft} onClick={onBack}>
          All buddies
        </Button>
      </>
    )
  const b = detail.buddy
  const running = detail.running || detail.onScreen

  const say = (text: string, urgent = false): void => {
    setMsg(text)
    announce(text, urgent ? 'assertive' : 'polite')
  }
  const runNow = async (): Promise<void> => {
    setBusy(true)
    const r = await window.lumen.invoke('buddies:run', { id }).catch(() => null)
    setBusy(false)
    if (r?.ok) say(r.onScreen ? `${b.name} is working on screen.` : `${b.name} is working.`)
    else say(`Not started: ${r?.error ?? 'something went wrong'}`, true)
    refresh()
  }
  const stop = async (): Promise<void> => {
    const r = await window.lumen.invoke('buddies:stop', id).catch(() => null)
    say(r?.ok ? `Stopped ${b.name}.` : `${b.name} was not working.`)
    refresh()
  }
  const setOn = async (enabled: boolean): Promise<void> => {
    await window.lumen.invoke('buddies:set-enabled', { id, enabled }).catch(() => null)
    announce(enabled ? `${b.name} is on` : `${b.name} is off`)
    refresh()
  }
  const save = async (): Promise<void> => {
    const bad = formProblems(form)
    setProblems(bad)
    if (bad.length) return announce(bad[0], 'assertive')
    setBusy(true)
    const r = await window.lumen.invoke('buddies:update', { id, fields: changes }).catch(() => null)
    setBusy(false)
    if (r?.ok) {
      setEdit(null)
      say(`Saved ${r.buddy.name}.`)
      refresh()
    } else say(`Not saved: ${r && !r.ok ? r.error : 'something went wrong'}`, true)
  }
  const exportIt = async (): Promise<void> => {
    const r = await window.lumen.invoke('buddies:export', { id }).catch(() => null)
    if (r?.ok) say(`Exported to ${r.path ?? 'the file'}.`)
    else if (r?.error !== 'cancelled')
      say(`Not exported: ${r?.error ?? 'something went wrong'}`, true)
  }
  const remove = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      announce(
        `Press Delete again to delete ${b.name} and its schedules. This cannot be undone.`,
        'assertive'
      )
      return
    }
    setConfirming(false)
    const r = await window.lumen.invoke('buddies:remove', id).catch(() => null)
    if (r?.ok) {
      announce(`Deleted ${b.name}`)
      onBack()
    } else say(`Not deleted.`, true)
  }

  return (
    <div className="bd-page">
      <Button variant="quiet" icon={icons.arrowLeft} onClick={onBack}>
        All buddies
      </Button>
      <section className="ui-card surface bd-head" aria-labelledby="bd-head-name">
        <BuddiesAvatar look={b.look} name={b.name} size="lg" />
        <div className="bd-head__text">
          <h2 id="bd-head-name" ref={headRef} tabIndex={-1} className="ui-card__title">
            {b.name}
          </h2>
          <span className="ui-hint" aria-live="polite">
            {detail.onScreen
              ? 'Working on screen'
              : detail.running
                ? 'Working…'
                : b.enabled
                  ? 'On'
                  : 'Off'}
          </span>
          {b.trust === 'community-untrusted' && (
            <span className="bd-badge">community, untrusted: asks before risky actions</span>
          )}
        </div>
        <div className="bd-head__actions">
          <Switch
            checked={b.enabled}
            onChange={(on) => void setOn(on)}
            label={<span className="visually-hidden">{b.name} on</span>}
          />
          <Button
            variant="primary"
            icon={icons.play}
            busy={busy}
            disabled={busy || !b.enabled}
            onClick={runNow}
          >
            Run now
          </Button>
          {running && (
            <Button icon={icons.square} onClick={stop}>
              Stop
            </Button>
          )}
        </div>
      </section>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}

      <Card title="This month" description="From the usage log on this PC.">
        <p>{monthLine(monthSpend(report, id), b.budget)}</p>
      </Card>

      <Card title="Details" description="Changes are saved together when you press Save changes.">
        <BuddiesFields value={form} onChange={setEdit} before={saved.permissions} />
        {problems.length > 0 && (
          <ul className="ui-hint" aria-label="Problems found" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="panel-row">
          <Button variant="primary" busy={busy} disabled={busy || !dirty} onClick={save}>
            Save changes
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              setEdit(null)
              setProblems([])
              announce('Changes undone')
            }}
          >
            Undo changes
          </Button>
        </div>
      </Card>

      <Schedules detail={detail} onChanged={refresh} />
      <Notebook id={id} name={b.name} />
      <Runs runs={runs} />

      <Card title="Share or delete">
        <div className="panel-row">
          <Button icon={icons.download} onClick={exportIt}>
            Export .lumen
          </Button>
          <Button
            variant="danger"
            icon={icons.trash}
            onClick={remove}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? `Press again to delete ${b.name}` : 'Delete'}
          </Button>
        </div>
        <p className="ui-hint">An exported buddy leaves out its notebook, schedules and folders.</p>
      </Card>
    </div>
  )
}
