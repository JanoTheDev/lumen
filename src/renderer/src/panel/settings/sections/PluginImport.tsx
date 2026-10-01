// Import from Claude Code (Settings → Skills): a plugin or marketplace on GitHub, a folder, or
// the user's own ~/.claude skills, commands, output styles and installed plugins. The preview
// lists every skill and connector Lumen would add, what it changes or leaves out (hooks never),
// and each connector needs its own "I trust" tick. Imported skills start untrusted.
import { useEffect, useRef, useState } from 'react'
import type {
  ClaudeHomeScan,
  PluginEnvChoice,
  PluginEnvPreview,
  PluginPreviewResult,
  PluginSource
} from '@shared/plugins'
import { Button, Card, announce, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'

type Ready = Extract<PluginPreviewResult, { ok: true }>

const FROM: Record<Ready['skills'][number]['from'], string> = {
  skill: 'skill',
  command: 'slash command',
  'output-style': 'output style → reply style'
}

function homeLine(s: ClaudeHomeScan): string {
  const parts = [
    s.skills && `${s.skills} ${s.skills === 1 ? 'skill' : 'skills'}`,
    s.commands && `${s.commands} ${s.commands === 1 ? 'command' : 'commands'}`,
    s.outputStyles && `${s.outputStyles} output ${s.outputStyles === 1 ? 'style' : 'styles'}`,
    s.plugins && `${s.plugins} installed ${s.plugins === 1 ? 'plugin' : 'plugins'}`
  ].filter(Boolean)
  return `Claude Code on this PC has ${parts.join(', ')}.`
}

/** One env entry of a connector: a value to type, or the plugin's own value to tick. */
function EnvRow({
  id,
  e,
  choice,
  onChange
}: {
  id: string
  e: PluginEnvPreview
  choice: PluginEnvChoice
  onChange: (next: PluginEnvChoice) => void
}): JSX.Element {
  if (e.kind === 'literal')
    return (
      <label className="panel-row">
        <input
          type="checkbox"
          checked={choice.keep?.includes(e.name) ?? false}
          onChange={(ev) => {
            const keep = new Set(choice.keep ?? [])
            if (ev.target.checked) keep.add(e.name)
            else keep.delete(e.name)
            onChange({ ...choice, keep: [...keep] })
          }}
        />
        <span>
          Use the plugin&apos;s value for <code>{e.name}</code>: <code>{e.masked}</code>
        </span>
      </label>
    )
  return (
    <div className="ui-field">
      <label htmlFor={id} className="ui-field__label">
        {e.name}
        {e.placeholder && e.placeholder !== e.name ? ` (the plugin calls it ${e.placeholder})` : ''}
      </label>
      <input
        id={id}
        className="ui-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={choice.values?.[e.name] ?? ''}
        placeholder="Leave empty to set it later"
        onChange={(ev) =>
          onChange({ ...choice, values: { ...choice.values, [e.name]: ev.target.value } })
        }
      />
    </div>
  )
}

export function PluginImport({ onImported }: { onImported: () => void }): JSX.Element {
  const [scan, setScan] = useState<ClaudeHomeScan | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [preview, setPreview] = useState<Ready | null>(null)
  const [trusted, setTrusted] = useState<Set<string>>(new Set())
  const [env, setEnv] = useState<Record<string, PluginEnvChoice>>({})
  const headingRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    invoke('plugins:scan')
      .then(setScan)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (preview) headingRef.current?.focus()
  }, [preview])

  const look = async (source: PluginSource): Promise<void> => {
    setBusy(true)
    setMsg('')
    setProblems([])
    try {
      const r = await invoke('plugins:preview', source)
      if ('ok' in r && r.ok) {
        setPreview(r)
        setTrusted(new Set())
        setEnv({})
      } else if ('ok' in r && r.error !== 'cancelled') {
        setMsg(`Nothing imported: ${r.error}`)
        setProblems(r.problems ?? [])
        announce(`Nothing imported: ${r.error}`, 'assertive')
      }
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const chosen = Object.fromEntries(Object.entries(env).filter(([k]) => trusted.has(k)))
      const r = await invoke('plugins:import', {
        token: preview.token,
        connectors: [...trusted],
        ...(Object.keys(chosen).length ? { env: chosen } : {})
      })
      setEnv({})
      setPreview(null)
      if ('ok' in r && r.ok) {
        const failed = r.connectors.filter((c) => !c.ok)
        const text = [
          r.skills.length
            ? `Imported ${r.skills.length} ${r.skills.length === 1 ? 'skill' : 'skills'}`
            : '',
          r.connectors.length - failed.length
            ? `added ${r.connectors.length - failed.length} connector(s)`
            : '',
          failed.length
            ? `${failed.length} connector(s) not added: ${failed.map((f) => f.error).join('; ')}`
            : ''
        ]
          .filter(Boolean)
          .join(', ')
        setMsg(text || 'Nothing was imported.')
        announce(text || 'Nothing was imported.')
        onImported()
      } else if ('ok' in r) {
        setMsg(`Not imported: ${r.error}`)
        setProblems(r.problems ?? [])
      }
    } finally {
      setBusy(false)
    }
  }

  const cancel = (): void => {
    if (preview) invoke('plugins:cancel', preview.token).catch(() => {})
    setPreview(null)
    announce('Import cancelled')
  }

  if (preview)
    return (
      <Card
        title={
          <span ref={headingRef} tabIndex={-1}>
            Import from Claude Code?
          </span>
        }
        description={`From ${preview.source}. Imported skills start untrusted: Lumen asks before every action they take, and they get no mouse, keyboard, web or file access until you give it. Lumen copies text and pictures only, never programs.`}
      >
        <p className="ui-hint">
          {preview.plugins.map((p) => `${p.name}${p.version ? ` ${p.version}` : ''}`).join(', ')}
        </p>
        {preview.skills.length > 0 && (
          <section aria-label="Skills">
            <h3>Skills</h3>
            <ul className="panel-list">
              {preview.skills.map((s) => (
                <li key={s.name} className="panel-list__item">
                  <div className="panel-list__text">
                    <span className="panel-list__title">
                      {s.name} {s.updates ? '(updates the imported one)' : ''}
                    </span>
                    <span className="ui-hint">
                      {s.description} · from a {FROM[s.from]} in {s.plugin}
                      {s.triggers.length ? ` · say “${s.triggers.join('”, “')}”` : ''}
                    </span>
                    {s.resetsTrust && (
                      <span className="ui-hint" role="note">
                        Its content changed since you trusted it, so it starts untrusted again.
                      </span>
                    )}
                    {s.notes.length > 0 && (
                      <ul className="ui-hint" aria-label={`Changes to ${s.name}`}>
                        {s.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {preview.connectors.length > 0 && (
          <section aria-label="Connectors">
            <h3>Connectors</h3>
            <p className="ui-hint">Only the ones you tick are added.</p>
            <ul className="panel-list">
              {preview.connectors.map((c) => (
                <li key={c.key} className="panel-list__item">
                  <div className="panel-list__text">
                    <span className="panel-list__title">
                      {c.name} ({c.plugin}) {c.exists === 'same' ? '· already added' : ''}
                    </span>
                    {c.exists !== 'same' && (
                      <label className="panel-row">
                        <input
                          type="checkbox"
                          checked={trusted.has(c.key)}
                          onChange={(e) => {
                            const next = new Set(trusted)
                            if (e.target.checked) next.add(c.key)
                            else next.delete(c.key)
                            setTrusted(next)
                          }}
                        />
                        {c.transport === 'stdio' ? (
                          <span>
                            I trust this command, which runs on my PC: <code>{c.commandLine}</code>
                          </span>
                        ) : (
                          <span>
                            I trust this server: <code>{c.url}</code>
                          </span>
                        )}
                      </label>
                    )}
                    {c.exists !== 'same' && c.env && c.env.length > 0 && trusted.has(c.key) && (
                      <fieldset className="panel-fieldset">
                        <legend className="ui-hint">
                          Settings it runs with. Values are stored encrypted on this PC; the
                          plugin&apos;s own values are used only when you tick them.
                        </legend>
                        {c.env.map((e) => (
                          <EnvRow
                            key={e.name}
                            id={`plugin-env-${c.key}-${e.name}`}
                            e={e}
                            choice={env[c.key] ?? {}}
                            onChange={(next) => setEnv({ ...env, [c.key]: next })}
                          />
                        ))}
                      </fieldset>
                    )}
                    {c.notes.length > 0 && (
                      <ul className="ui-hint">
                        {c.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {preview.skipped.length > 0 && (
          <section aria-label="Not imported">
            <h3>Not imported</h3>
            <ul className="ui-hint">
              {preview.skipped.map((s) => (
                <li key={`${s.what}${s.why}`}>
                  {s.what}: {s.why}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="panel-row">
          <Button variant="primary" busy={busy} onClick={() => void run()}>
            Import
          </Button>
          <Button onClick={cancel}>Cancel</Button>
        </div>
      </Card>
    )

  return (
    <Card
      title="Import from Claude Code"
      description="Claude Code plugins and skills work in Lumen too: skills and slash commands become skills, output styles become reply styles, and MCP servers become connectors. Hooks are never imported, because they run commands on your PC whenever something happens."
    >
      {scan?.found && (
        <div className="panel-row">
          <span className="ui-hint">{homeLine(scan)}</span>
          <Button
            icon={icons.download}
            busy={busy}
            onClick={() => void look({ kind: 'claude-home' })}
          >
            Import my Claude Code skills
          </Button>
        </div>
      )}
      <div className="panel-row">
        <Button busy={busy} onClick={() => void look({ kind: 'folder' })}>
          Choose a plugin folder
        </Button>
      </div>
      <div className="panel-row panel-row--end">
        <div className="ui-field">
          <label htmlFor="plugin-url" className="ui-field__label">
            GitHub link to a plugin or marketplace
          </label>
          <input
            id="plugin-url"
            className="ui-input"
            type="url"
            value={url}
            placeholder="https://github.com/someone/claude-plugins"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <Button
          busy={busy}
          disabled={!url.trim()}
          onClick={() => void look({ kind: 'github', url: url.trim() })}
        >
          Check
        </Button>
      </div>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
      {problems.length > 0 && (
        <ul className="ui-hint" aria-label="Problems found">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Card>
  )
}
