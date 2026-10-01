// Integrations catalog (Settings → Connectors): well-known MCP servers, each checked against
// its vendor's docs, added in one step. Web servers sign in in the browser or take a token;
// local commands show the exact command line and need "I trust this command", like the form.
import { useState } from 'react'
import { CONNECTOR_CATALOG, type CatalogEntry } from '@shared/connector-catalog'
import type { ConnectorView } from '@shared/connectors'
import { Button, Card, Field, SegmentedControl, announce, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'
import {
  authLine,
  catalogCommandLine,
  catalogGroups,
  catalogInput,
  defaultMethod,
  isAdded,
  type CatalogChoice
} from './connectors-catalog-view'

function EntryForm({
  e,
  taken,
  onDone
}: {
  e: CatalogEntry
  taken: string[]
  onDone: (msg: string) => void
}): JSX.Element {
  const [choice, setChoice] = useState<CatalogChoice>({
    method: defaultMethod(e),
    token: '',
    folders: ''
  })
  const [trustedFor, setTrustedFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const line = e.kind === 'local' ? catalogCommandLine(e, choice.folders) : ''
  const trusted = trustedFor === line

  const methods: { value: CatalogChoice['method']; label: string }[] = [
    ...(e.oauth ? [{ value: 'oauth' as const, label: 'Sign in' }] : []),
    ...(e.token ? [{ value: 'token' as const, label: 'Access token' }] : []),
    ...(e.token && !e.token.required && !e.oauth
      ? [{ value: 'none' as const, label: 'No token' }]
      : [])
  ]

  const add = async (): Promise<void> => {
    const r = catalogInput(e, choice, taken, trusted)
    if ('error' in r) {
      setError(r.error)
      announce(r.error, 'assertive')
      return
    }
    setBusy(true)
    setError('')
    try {
      const added = await invoke('connectors:add', r.input)
      if ('error' in added && added.error === 'E_INVALID') return setError('Not accepted.')
      if (!added.ok) return setError(added.error)
      if (r.input.auth === 'oauth') {
        announce(`${e.name} added. Your browser opens to sign in.`)
        const s = await invoke('connectors:sign-in', r.input.id)
        onDone(s.ok ? `${e.name} added and signed in.` : `${e.name} added. Sign-in: ${s.error}`)
      } else onDone(`${e.name} added.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-subform">
      {e.needs && (
        <p className="ui-hint">
          <icons.info /> Needs {e.needs}.
        </p>
      )}
      {methods.length > 1 && (
        <SegmentedControl
          label="How to connect"
          value={choice.method}
          options={methods}
          onChange={(method) => setChoice({ ...choice, method })}
        />
      )}
      {choice.method === 'token' && (
        <Field label="Access token" hint={e.token?.hint}>
          {(a) => (
            <input
              {...a}
              type="password"
              className="ui-input ui-input--mono"
              autoComplete="off"
              spellCheck={false}
              value={choice.token}
              onChange={(ev) => setChoice({ ...choice, token: ev.target.value })}
            />
          )}
        </Field>
      )}
      {choice.method === 'oauth' && (
        <p className="ui-hint">
          Your browser opens the sign-in page. Lumen keeps the sign-in encrypted on this PC.
        </p>
      )}
      {e.folders && (
        <Field label={e.folders.label}>
          {(a) => (
            <textarea
              {...a}
              className="ui-input ui-input--mono"
              rows={e.folders?.single ? 1 : 3}
              spellCheck={false}
              value={choice.folders}
              onChange={(ev) => setChoice({ ...choice, folders: ev.target.value })}
            />
          )}
        </Field>
      )}
      {e.kind === 'local' && (
        <>
          <div className="panel-note" role="note">
            <icons.alert />
            <span>
              This exact command runs on your PC with your permissions: <code>{line}</code>
            </span>
          </div>
          <label className="panel-row">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(ev) => setTrustedFor(ev.target.checked ? line : null)}
            />
            I trust this command
          </label>
        </>
      )}
      <div className="panel-row">
        <Button
          variant="primary"
          icon={icons.check}
          busy={busy}
          disabled={busy}
          onClick={() => void add()}
        >
          {choice.method === 'oauth' ? 'Add and sign in' : 'Add'}
        </Button>
      </div>
      {error && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function ConnectorsCatalog({
  list,
  onAdded
}: {
  list: ConnectorView[]
  onAdded: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const groups = catalogGroups(query)
  const taken = list.map((c) => c.id)
  const count = groups.reduce((n, [, l]) => n + l.length, 0)

  return (
    <Card
      title="Browse integrations"
      description="Well-known MCP servers, each checked against its maker's own documentation. Every tool call still goes through the safety policy, and tools that change data always ask first."
    >
      <div className="panel-search">
        <icons.search />
        <input
          type="search"
          aria-label="Search integrations"
          placeholder="Search integrations"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
        />
      </div>
      <p className="ui-hint" aria-live="polite">
        {query
          ? `${count} of ${CONNECTOR_CATALOG.length}`
          : `${CONNECTOR_CATALOG.length} integrations`}
      </p>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
      {groups.map(([category, entries]) => (
        <section key={category} aria-label={category}>
          <h3>{category}</h3>
          <ul className="panel-list">
            {entries.map((e) => {
              const added = isAdded(e, list)
              return (
                <li key={e.id} className="panel-list__item">
                  <div className="panel-list__text">
                    <span className="panel-list__title">{e.name}</span>
                    <span className="ui-hint">
                      {e.description} · {authLine(e)} ·{' '}
                      <a href={e.source} target="_blank" rel="noreferrer">
                        Official docs
                      </a>{' '}
                      (checked {e.checked})
                    </span>
                    {open === e.id && !added && (
                      <EntryForm
                        e={e}
                        taken={taken}
                        onDone={(text) => {
                          setOpen(null)
                          setMsg(text)
                          announce(text)
                          onAdded()
                        }}
                      />
                    )}
                  </div>
                  {added ? (
                    <span className="ui-hint">Added</span>
                  ) : (
                    <Button
                      variant={open === e.id ? 'quiet' : undefined}
                      aria-expanded={open === e.id}
                      onClick={() => setOpen(open === e.id ? null : e.id)}
                    >
                      {open === e.id ? 'Close' : 'Add'}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </Card>
  )
}
