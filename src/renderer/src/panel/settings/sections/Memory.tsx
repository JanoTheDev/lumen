// Settings → Memory (05 memory.md): the switches, the review queue, what Lumen knows about you
// and your apps, past sessions (search / delete), export, open folder and delete all behind a
// typed confirm. Data comes from memory:get and refreshes on memory:changed.
import { useCallback, useEffect, useId, useState } from 'react'
import type {
  MemoryEpisodeView,
  MemoryFactOp,
  MemoryFactView,
  MemoryLayerName,
  MemoryOverview,
  MemoryResult
} from '@shared/channels'
import {
  Button,
  Card,
  IconButton,
  NumberField,
  SegmentedControl,
  Switch,
  announce,
  icons
} from '../../../ui'
import { useIpc } from '../../../lib/ipc'
import type { SectionProps } from '../meta'

const DELETE_WORD = 'DELETE'
const SEARCH_DELAY_MS = 250

function factMeta(f: MemoryFactView): string {
  return [f.section, f.source === 'said' ? 'you said' : 'learned', f.date]
    .filter(Boolean)
    .join(' · ')
}

function FactList({
  facts,
  layer,
  app,
  onRemove
}: {
  facts: MemoryFactView[]
  layer: MemoryLayerName
  app?: string
  onRemove: (op: MemoryFactOp, text: string) => void
}): JSX.Element {
  if (!facts.length) return <p className="ui-hint">Nothing yet.</p>
  return (
    <ul className="panel-list">
      {facts.map((f) => (
        <li key={`${f.section}:${f.text}`} className="panel-list__item">
          <div className="panel-list__text">
            <span className="panel-list__title">{f.text}</span>
            <span className="ui-hint">{factMeta(f)}</span>
          </div>
          <IconButton
            icon={icons.trash}
            label={`Forget “${f.text}”`}
            onClick={() => onRemove({ op: 'remove', layer, app, text: f.text }, 'Forgotten')}
          />
        </li>
      ))}
    </ul>
  )
}

/** A labelled text input with a button beside it (Enter runs it too). */
function InlineForm({
  label,
  placeholder,
  action,
  onSubmit
}: {
  label: string
  placeholder?: string
  action: string
  onSubmit: (text: string) => Promise<boolean>
}): JSX.Element {
  const id = useId()
  const [text, setText] = useState('')
  const submit = async (): Promise<void> => {
    if (!text.trim()) return
    if (await onSubmit(text.trim())) setText('')
  }
  return (
    <div className="panel-row panel-row--end">
      <div className="ui-field">
        <label htmlFor={id} className="ui-field__label">
          {label}
        </label>
        <input
          id={id}
          className="ui-input"
          value={text}
          maxLength={300}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </div>
      <Button onClick={submit} disabled={!text.trim()}>
        {action}
      </Button>
    </div>
  )
}

export function Memory({ cfg, patch }: SectionProps): JSX.Element {
  const m = cfg.memory
  const [data, setData] = useState<MemoryOverview | null>(null)
  const [episodes, setEpisodes] = useState<MemoryEpisodeView[]>([])
  const [query, setQuery] = useState('')
  const [msg, setMsg] = useState('')
  const [confirmWord, setConfirmWord] = useState('')
  const searchId = useId()
  const confirmId = useId()

  const refresh = useCallback(() => {
    window.lumen
      .invoke('memory:get')
      .then(setData)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh, m.enabled])
  useIpc('memory:changed', refresh)

  const episodeCount = data?.episodeCount
  useEffect(() => {
    const t = window.setTimeout(() => {
      window.lumen
        .invoke('memory:episodes', query.trim() || undefined)
        .then(setEpisodes)
        .catch(() => {})
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [query, episodeCount])

  const say = (text: string, ok: boolean): void => {
    setMsg(text)
    announce(text, ok ? 'polite' : 'assertive')
  }
  const run = async (call: Promise<MemoryResult>, done: string): Promise<boolean> => {
    try {
      const r = await call
      say(r.ok ? done : (r.error ?? 'That didn’t work.'), r.ok)
      if (r.ok) refresh()
      return r.ok
    } catch {
      say('That didn’t work. Try again.', false)
      return false
    }
  }
  const fact = (op: MemoryFactOp, done: string): Promise<boolean> =>
    run(window.lumen.invoke('memory:fact', op), done)

  const exportAll = async (): Promise<void> => {
    try {
      const r = await window.lumen.invoke('memory:export')
      say(r.ok ? `Saved to ${r.path ?? 'Downloads'}` : (r.error ?? 'Export failed.'), r.ok)
    } catch {
      say('Export failed.', false)
    }
  }

  const deleteAll = async (): Promise<void> => {
    if (confirmWord !== DELETE_WORD) return
    if (await run(window.lumen.invoke('memory:delete-all', confirmWord), 'Everything is deleted'))
      setConfirmWord('')
  }

  const pending = data?.pending ?? []

  return (
    <>
      <Card
        title="Memory"
        description="Lumen can remember your preferences and how you use your apps. It stays on this PC."
      >
        <Switch
          checked={m.enabled}
          onChange={(enabled) => patch({ memory: { enabled } })}
          label="Remember things about me"
        />
        <SegmentedControl
          label="Learning new things"
          value={m.autoLearn}
          options={[
            { value: 'ask', label: 'Ask me first' },
            { value: 'auto', label: 'Automatically' },
            { value: 'off', label: 'Don’t learn' }
          ]}
          onChange={(autoLearn) => patch({ memory: { autoLearn } })}
        />
        <Switch
          checked={m.privateMode}
          onChange={(privateMode) => patch({ memory: { privateMode } })}
          label="Private mode"
          hint="Lumen uses what it already knows but saves nothing new."
        />
        <NumberField
          label="Forget after"
          value={m.retentionDays}
          min={1}
          max={3650}
          unit="days"
          onCommit={(retentionDays) => patch({ memory: { retentionDays } })}
        />
      </Card>

      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}

      {pending.length > 0 && (
        <Card
          title="Waiting for your OK"
          description="Lumen noticed these. Keep the ones that are right."
        >
          <ul className="panel-list">
            {pending.map((p) => (
              <li key={p.id} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">{p.fact}</span>
                  <span className="ui-hint">{p.appId ? `About ${p.appId}` : 'About you'}</span>
                </div>
                <Button
                  variant="primary"
                  onClick={() =>
                    void run(
                      window.lumen.invoke('memory:review', { id: p.id, accept: true }),
                      'Kept'
                    )
                  }
                >
                  Keep
                </Button>
                <Button
                  onClick={() =>
                    void run(
                      window.lumen.invoke('memory:review', { id: p.id, accept: false }),
                      'Dropped'
                    )
                  }
                >
                  Drop
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="About you" description="What Lumen keeps in mind in every conversation.">
        <FactList
          facts={data?.profile ?? []}
          layer="profile"
          onRemove={(op, done) => void fact(op, done)}
        />
        {m.enabled && (
          <InlineForm
            label="Add something"
            placeholder="I use a screen magnifier"
            action="Add"
            onSubmit={(text) => fact({ op: 'add', layer: 'profile', text }, 'Added')}
          />
        )}
      </Card>

      {(data?.working.length ?? 0) > 0 && (
        <Card title="Right now" description="Notes for the task at hand; they fade on their own.">
          <FactList
            facts={data?.working ?? []}
            layer="working"
            onRemove={(op, done) => void fact(op, done)}
          />
        </Card>
      )}

      <Card title="Your apps" description="What Lumen learned about how you use each app.">
        {data?.apps.length ? (
          data.apps.map((a) => (
            <section key={a.id} aria-label={a.id}>
              <h3 className="ui-hint">{a.id}</h3>
              <FactList
                facts={a.facts}
                layer="app"
                app={a.id}
                onRemove={(op, done) => void fact(op, done)}
              />
            </section>
          ))
        ) : (
          <p className="ui-hint">Nothing yet.</p>
        )}
      </Card>

      <Card
        title="Past sessions"
        description={`${data?.episodeCount ?? 0} saved. Lumen looks back at these when you continue something.`}
      >
        <div className="ui-field">
          <label htmlFor={searchId} className="ui-field__label">
            Search
          </label>
          <input
            id={searchId}
            type="search"
            className="ui-input"
            value={query}
            placeholder="email to Sam"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {episodes.length ? (
          <ul className="panel-list">
            {episodes.map((e) => (
              <li key={e.id} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">{e.title}</span>
                  <span className="ui-hint">
                    {[new Date(e.date).toLocaleDateString(), e.apps.join(', '), e.summary]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <IconButton
                  icon={icons.trash}
                  label={`Delete “${e.title}”`}
                  onClick={() =>
                    void run(window.lumen.invoke('memory:episode-delete', e.id), 'Deleted')
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="ui-hint">{query ? 'No matches.' : 'Nothing yet.'}</p>
        )}
      </Card>

      <Card title="Your data" description={data?.dir ? `Kept in ${data.dir}` : undefined}>
        <div className="panel-row">
          <Button icon={icons.external} onClick={() => window.lumen.send('memory:open-folder')}>
            Open folder
          </Button>
          <Button icon={icons.download} onClick={exportAll}>
            Export as zip
          </Button>
        </div>
        <div className="panel-row panel-row--end">
          <div className="ui-field">
            <label htmlFor={confirmId} className="ui-field__label">
              Type {DELETE_WORD} to delete everything Lumen remembers
            </label>
            <input
              id={confirmId}
              className="ui-input"
              value={confirmWord}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setConfirmWord(e.target.value)}
            />
          </div>
          <Button
            variant="danger"
            icon={icons.trash}
            disabled={confirmWord !== DELETE_WORD}
            onClick={deleteAll}
          >
            Delete all
          </Button>
        </div>
      </Card>
    </>
  )
}
