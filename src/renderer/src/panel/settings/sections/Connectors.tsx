// Connectors (08 T19): MCP servers whose tools agent tasks may use. A local command runs only
// after the user ticked "I trust this command" for exactly the command line shown. Tokens and
// environment values are write-only: stored encrypted in main, never sent back here.
import { useCallback, useEffect, useState } from 'react'
import {
  commandLine,
  type ConnectorToolInfo,
  type ConnectorTransport,
  type ConnectorView,
  type ToolPolicy
} from '@shared/connectors'
import { Button, Card, Field, SegmentedControl, Select, Switch, announce, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'
import { idFromName, parseArgs, parseEnv } from './connectors-form'
import { ConnectorsCatalog } from './ConnectorsCatalog'

const STATE_TEXT: Record<ConnectorView['state'], string> = {
  off: 'Off',
  idle: 'Connects when a task needs it',
  connected: 'Connected',
  error: 'Not connected'
}

const POLICY_OPTIONS: { value: ToolPolicy | 'default'; label: string }[] = [
  { value: 'default', label: 'Ask until allowed' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Off (never offered)' }
]

function inputOf(c: ConnectorView): {
  id: string
  name: string
  transport: ConnectorTransport
  command?: string
  args?: string[]
  url?: string
  auth?: 'oauth'
  enabled: boolean
  toolPolicy: Record<string, ToolPolicy>
} {
  return {
    id: c.id,
    name: c.name,
    transport: c.transport,
    ...(c.transport === 'stdio'
      ? { command: c.command, args: c.args ?? [] }
      : { url: c.url, ...(c.auth ? { auth: c.auth } : {}) }),
    enabled: c.enabled,
    toolPolicy: c.toolPolicy
  }
}

function ServerCard({ c, onChanged }: { c: ConnectorView; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [tools, setTools] = useState<ConnectorToolInfo[] | null>(null)
  const [token, setToken] = useState('')

  const say = (text: string, urgent = false): void => {
    setMsg(text)
    announce(text, urgent ? 'assertive' : 'polite')
  }

  const update = async (
    patch: Partial<ReturnType<typeof inputOf>> & { bearer?: string }
  ): Promise<boolean> => {
    const r = await invoke('connectors:update', { ...inputOf(c), ...patch })
    if (!r.ok) say(r.error, true)
    onChanged()
    return r.ok
  }

  const saveToken = async (): Promise<void> => {
    const ok = await update({ bearer: token })
    setToken('')
    if (ok) say(token ? 'Token saved, encrypted on this PC.' : 'Token removed.')
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await invoke('connectors:test', c.id)
      say(
        r.ok
          ? `Connected. ${r.toolCount} ${r.toolCount === 1 ? 'tool' : 'tools'}.`
          : `Could not connect: ${r.error}`,
        !r.ok
      )
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const signIn = async (): Promise<void> => {
    setBusy(true)
    say('Your browser opens the sign-in page. Come back here when it says you are signed in.')
    try {
      const r = await invoke('connectors:sign-in', c.id)
      say(r.ok ? 'Signed in.' : `Not signed in: ${r.error}`, !r.ok)
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const signOut = async (): Promise<void> => {
    const r = await invoke('connectors:sign-out', c.id)
    say(r.ok ? 'Signed out. The saved sign-in was deleted.' : r.error, !r.ok)
    onChanged()
  }

  const loadTools = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await invoke('connectors:tools', c.id)
      if ('error' in r) say(`Could not list tools: ${r.error}`, true)
      else setTools(r)
    } finally {
      setBusy(false)
    }
  }

  const setPolicy = async (tool: string, p: ToolPolicy | 'default'): Promise<void> => {
    const toolPolicy = { ...c.toolPolicy }
    if (p === 'default') delete toolPolicy[tool]
    else toolPolicy[tool] = p
    await update({ toolPolicy })
    setTools((list) => list?.map((t) => (t.name === tool ? { ...t, policy: p } : t)) ?? null)
  }

  const state =
    c.state === 'connected' && c.toolCount !== undefined
      ? `Connected, ${c.toolCount} tools`
      : STATE_TEXT[c.state]

  return (
    <Card
      title={c.name}
      level={3}
      description={c.transport === 'stdio' ? 'Local command' : 'Web server'}
    >
      <p className="ui-hint">
        {c.transport === 'stdio' ? (
          <>
            Runs: <code>{c.commandLine}</code>
          </>
        ) : (
          <>
            URL: <code>{c.url}</code>
            {c.hasBearer ? ' (token saved)' : ''}
            {c.auth === 'oauth' ? (c.signedIn ? ' (signed in)' : ' (not signed in)') : ''}
          </>
        )}
      </p>
      <div className={c.state === 'connected' ? 'panel-note is-ok' : 'panel-note'} role="status">
        {c.state === 'connected' ? <icons.checkCircle /> : <icons.info />}
        <span>
          {state}
          {c.state === 'error' && c.error ? `: ${c.error}` : '.'}
        </span>
      </div>
      <Switch
        label="Use in agent tasks"
        checked={c.enabled}
        onChange={(v) => void update({ enabled: v })}
      />
      <div className="panel-row">
        <Button busy={busy} disabled={busy} onClick={() => void test()}>
          Test
        </Button>
        <Button disabled={busy} onClick={() => void loadTools()}>
          {tools ? 'Refresh tools' : 'Show tools'}
        </Button>
        <Button
          variant="quiet"
          icon={icons.trash}
          disabled={busy}
          onClick={() => {
            invoke('connectors:remove', c.id)
              .then(() => {
                announce(`${c.name} removed`)
                onChanged()
              })
              .catch(() => {})
          }}
        >
          Remove
        </Button>
      </div>
      {c.transport === 'http' && (c.auth === 'oauth' || !c.hasBearer) && (
        <div className="panel-row">
          <Button
            icon={icons.key}
            variant={c.auth === 'oauth' ? 'secondary' : 'quiet'}
            busy={busy}
            disabled={busy}
            onClick={() => void signIn()}
          >
            {c.auth !== 'oauth' ? 'Sign in with OAuth' : c.signedIn ? 'Sign in again' : 'Sign in'}
          </Button>
          {c.auth === 'oauth' && c.signedIn && (
            <Button variant="quiet" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </Button>
          )}
        </div>
      )}
      {c.transport === 'http' && (
        <Field
          label="Access token"
          hint={
            c.hasBearer
              ? 'A token is saved. Paste a new one to replace it, or save an empty field to remove it.'
              : 'Optional. Sent as a Bearer token; stored encrypted on this PC.'
          }
        >
          {(a) => (
            <div className="panel-row">
              <input
                {...a}
                type="password"
                className="ui-input ui-input--mono"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button
                icon={icons.key}
                disabled={busy || (!token && !c.hasBearer)}
                onClick={() => void saveToken()}
              >
                {token || !c.hasBearer ? 'Save token' : 'Remove token'}
              </Button>
            </div>
          )}
        </Field>
      )}
      {msg && <p className="ui-hint">{msg}</p>}
      {tools && !tools.length && <p className="ui-hint">This server has no tools.</p>}
      {tools?.map((t) => (
        <Select
          key={t.name}
          label={`${t.name}${t.destructive ? ' (can delete data: always asks)' : t.readOnly ? ' (read-only)' : ''}`}
          hint={t.description || undefined}
          value={t.policy}
          options={POLICY_OPTIONS}
          onChange={(p) => void setPolicy(t.name, p)}
        />
      ))}
    </Card>
  )
}

function AddForm({ taken, onAdded }: { taken: string[]; onAdded: () => void }): JSX.Element {
  const [transport, setTransport] = useState<ConnectorTransport>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [bearer, setBearer] = useState('')
  // The command line the user ticked "I trust" for; any change needs the tick again.
  const [trustedFor, setTrustedFor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const id = idFromName(name, taken)
  const argList = parseArgs(args)
  const envParsed = parseEnv(env)
  const preview = commandLine(command.trim(), argList)
  const trust = trustedFor === preview

  const ready =
    !!name.trim() &&
    !!id &&
    (transport === 'stdio' ? !!command.trim() && trust && !envParsed.error : !!url.trim())

  const add = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await invoke('connectors:add', {
        id,
        name: name.trim(),
        transport,
        ...(transport === 'stdio'
          ? {
              command: command.trim(),
              args: argList,
              trustCommand: trust,
              ...(Object.keys(envParsed.env).length ? { env: envParsed.env } : {})
            }
          : { url: url.trim(), ...(bearer ? { bearer } : {}) })
      })
      if ('error' in r && r.error === 'E_INVALID') {
        setError('Check the fields: an id, name or value is not accepted.')
        return
      }
      if (!r.ok) {
        setError(r.error)
        announce(r.error, 'assertive')
        return
      }
      announce(`${name.trim()} added`)
      setName('')
      setCommand('')
      setArgs('')
      setEnv('')
      setUrl('')
      setBearer('')
      onAdded()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Add a connector"
      description="A connector is an MCP server. Its tools become available to agent tasks; every call is checked by the safety policy, and tools that change data always ask first."
    >
      <SegmentedControl
        label="Kind"
        value={transport}
        options={[
          { value: 'stdio', label: 'Local command' },
          { value: 'http', label: 'Web server' }
        ]}
        onChange={setTransport}
      />
      <Field label="Name" hint={id ? `Tools appear as mcp__${id}__<tool>.` : undefined}>
        {(a) => (
          <input
            {...a}
            className="ui-input"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      {transport === 'stdio' ? (
        <>
          <Field
            label="Command"
            hint="The program that starts the server, for example npx or a full path."
          >
            {(a) => (
              <input
                {...a}
                className="ui-input ui-input--mono"
                spellCheck={false}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            )}
          </Field>
          <Field label="Arguments" hint="One per line.">
            {(a) => (
              <textarea
                {...a}
                className="ui-input ui-input--mono"
                rows={3}
                spellCheck={false}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Environment variables"
            hint="NAME=value, one per line. Stored encrypted on this PC and never shown again."
            error={envParsed.error}
          >
            {(a) => (
              <textarea
                {...a}
                className="ui-input ui-input--mono"
                rows={2}
                spellCheck={false}
                autoComplete="off"
                value={env}
                onChange={(e) => setEnv(e.target.value)}
              />
            )}
          </Field>
          {command.trim() && (
            <div className="panel-note" role="note">
              <icons.alert />
              <span>
                This exact command runs on your PC with your permissions: <code>{preview}</code>
              </span>
            </div>
          )}
          <label className="panel-row">
            <input
              type="checkbox"
              checked={trust}
              disabled={!command.trim()}
              onChange={(e) => setTrustedFor(e.target.checked ? preview : null)}
            />
            I trust this command
          </label>
        </>
      ) : (
        <>
          <Field label="Server URL" hint="https:// (http:// only for a server on this PC).">
            {(a) => (
              <input
                {...a}
                className="ui-input ui-input--mono"
                inputMode="url"
                spellCheck={false}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Access token (optional)"
            hint="Sent as a Bearer token. Stored encrypted on this PC."
          >
            {(a) => (
              <input
                {...a}
                type="password"
                className="ui-input ui-input--mono"
                autoComplete="off"
                spellCheck={false}
                value={bearer}
                onChange={(e) => setBearer(e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      <div className="panel-row">
        <Button
          variant="primary"
          icon={icons.check}
          busy={busy}
          disabled={!ready || busy}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      {error && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}

export function Connectors(): JSX.Element {
  const [list, setList] = useState<ConnectorView[] | null>(null)
  const refresh = useCallback(() => {
    invoke('connectors:list')
      .then(setList)
      .catch(() => setList([]))
  }, [])
  useEffect(refresh, [refresh])

  return (
    <>
      {list === null && <p className="ui-hint">Loading connectors…</p>}
      {list?.length === 0 && (
        <p className="ui-hint">
          No connectors yet. Pick one under Browse integrations, or add any MCP server by hand.
        </p>
      )}
      {list?.map((c) => (
        <ServerCard key={c.id} c={c} onChanged={refresh} />
      ))}
      {list && <ConnectorsCatalog list={list} onAdded={refresh} />}
      <AddForm taken={list?.map((c) => c.id) ?? []} onAdded={refresh} />
    </>
  )
}
