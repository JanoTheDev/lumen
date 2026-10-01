// Install skills (11 T06): a `.lumen` file or a GitHub link, then a permissions screen that
// lists what each skill may do before anything is written. Community skills start untrusted.
import { useEffect, useRef, useState } from 'react'
import type { PackInstallResult, SkillInstallPreview } from '@shared/channels'
import { Button, Card, announce, icons } from '../../../ui'
import { permissionLines } from './SkillsText'

type Ready = Extract<SkillInstallPreview, { ok: true }>

export function SkillsInstall({ onInstalled }: { onInstalled: () => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [preview, setPreview] = useState<Ready | null>(null)
  const headingRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (preview) headingRef.current?.focus()
  }, [preview])

  const fail = (error: string, list: string[] = []): void => {
    if (error === 'cancelled') return
    setMsg(`Not installed: ${error}`)
    setProblems(list)
    announce(`Not installed: ${error}`, 'assertive')
  }

  const look = async (p: Promise<SkillInstallPreview>): Promise<void> => {
    setBusy(true)
    setMsg('')
    setProblems([])
    try {
      const r = await p
      if (r.ok) setPreview(r)
      else fail(r.error, r.problems)
    } finally {
      setBusy(false)
    }
  }

  const install = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const r: PackInstallResult = await window.lumen.invoke('skills:install', preview.token)
      setPreview(null)
      if (r.ok) {
        const text = `Installed ${r.installed.map((s) => `${s.name}${s.updated ? ' (updated)' : ''}`).join(', ')}`
        setMsg(text)
        announce(text)
        setUrl('')
        onInstalled()
      } else fail(r.error, r.problems)
    } finally {
      setBusy(false)
    }
  }

  const cancel = (): void => {
    if (preview) window.lumen.invoke('skills:install-cancel', preview.token).catch(() => {})
    setPreview(null)
    announce('Install cancelled')
  }

  if (preview)
    return (
      <Card
        title={
          <span ref={headingRef} tabIndex={-1}>
            Install {preview.skills.length === 1 ? 'this skill' : `${preview.skills.length} skills`}
            ?
          </span>
        }
        description={`From ${preview.source}. Community skills start untrusted: Lumen asks before every action they take. Skills hold only text and pictures, never programs.`}
      >
        <ul className="panel-list" aria-label="Skills in this file">
          {preview.skills.map((s) => (
            <li key={s.name} className="panel-list__item">
              <div className="panel-list__text">
                <span className="panel-list__title">
                  {s.name} {s.updates ? '(replaces the installed one)' : ''}
                </span>
                <span className="ui-hint">
                  {s.description} · v{s.version}
                  {s.author ? ` · by ${s.author}` : ''}
                </span>
                {s.resetsTrust && (
                  <span className="ui-hint" role="note">
                    You trusted the installed {s.name}. This one comes from a different pack, so it
                    starts untrusted: it asks before each action until you trust it again.
                  </span>
                )}
                <ul aria-label={`What ${s.name} may do`}>
                  {permissionLines(s.permissions, s.apps).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {s.triggers.length > 0 && (
                  <span className="ui-hint">Say: {s.triggers.map((t) => `“${t}”`).join(', ')}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="panel-row">
          <Button variant="primary" busy={busy} onClick={install}>
            Install
          </Button>
          <Button onClick={cancel}>Cancel</Button>
        </div>
      </Card>
    )

  return (
    <Card
      title="Install skills"
      description="Skills other people made, as a .lumen file or a GitHub link. You see what each skill may do before it installs."
    >
      <div className="panel-row">
        <Button
          icon={icons.download}
          busy={busy}
          onClick={() => look(window.lumen.invoke('skills:preview-file'))}
        >
          Install from a file
        </Button>
      </div>
      <div className="panel-row panel-row--end">
        <div className="ui-field">
          <label htmlFor="skill-url" className="ui-field__label">
            GitHub link
          </label>
          <input
            id="skill-url"
            className="ui-input"
            type="url"
            value={url}
            placeholder="https://github.com/someone/lumen-skills"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <Button
          busy={busy}
          disabled={!url.trim()}
          onClick={() => look(window.lumen.invoke('skills:preview-url', url.trim()))}
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
