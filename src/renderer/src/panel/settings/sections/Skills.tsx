// Settings → Skills (11 T05): every skill Lumen knows (built in, from app packs, yours,
// community), with search, on/off, what it may do, trust, view and edit SKILL.md, export and
// delete, and its recent runs; plus making a new skill and installing shared ones.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillDetail } from '@shared/channels'
import type { SkillRunRecord, SkillSummary } from '@shared/types'
import { Button, Card, IconButton, Switch, announce, icons } from '../../../ui'
import { SkillsCompose } from './SkillsCompose'
import { SkillsInstall } from './SkillsInstall'
import { TRUST_LABEL, filterSkills, permissionLines, runLine, skillMeta } from './SkillsText'

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function SkillEditor({
  name,
  onClose,
  onSaved
}: {
  name: string
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [runs, setRuns] = useState<SkillRunRecord[]>([])
  const headingRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    window.lumen
      .invoke('skills:get', name)
      .then((r) => {
        if (r.ok) {
          setDetail(r)
          setText(r.text)
        } else setError(r.error)
      })
      .catch(() => setError('could not load the skill'))
    window.lumen
      .invoke('skills:runs', name)
      .then((r) => setRuns(Array.isArray(r) ? r : []))
      .catch(() => {})
  }, [name])
  useEffect(() => headingRef.current?.focus(), [])

  const save = async (): Promise<void> => {
    const r = await window.lumen.invoke('skills:save', name, text)
    if (r.ok) {
      announce(detail?.summary.origin === 'user' ? 'Saved' : 'Saved as your own copy')
      setEditing(false)
      setProblems([])
      onSaved()
    } else {
      setProblems([r.error, ...(r.problems ?? [])])
      announce(`Not saved: ${r.error}`, 'assertive')
    }
  }

  const s = detail?.summary
  return (
    <Card
      title={
        <span ref={headingRef} tabIndex={-1}>
          {name}
        </span>
      }
      description={s?.description}
      actions={<IconButton icon={icons.close} label="Close" onClick={onClose} />}
    >
      {error && <p className="ui-hint">{error}</p>}
      {s && (
        <>
          <p className="ui-hint">{skillMeta(s)}</p>
          {s.when_to_use && <p className="ui-hint">Used when: {s.when_to_use}</p>}
          {s.needsUpdate && (
            <p className="ui-hint" role="status">
              Its last runs did not go as recorded. Say “update the {name.replace(/-/g, ' ')} skill”
              and Lumen rewrites it from the last run that worked.
            </p>
          )}
          <h3>What it may do</h3>
          <ul>
            {permissionLines(s.permissions, s.apps).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {s.triggers.length > 0 && (
            <p className="ui-hint">Say: {s.triggers.map((t) => `“${t}”`).join(', ')}</p>
          )}
          {s.warnings.length > 0 && (
            <ul aria-label="Warnings" className="ui-hint">
              {s.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <h3>Recent runs</h3>
          {runs.length ? (
            <ul aria-label="Recent runs" className="ui-hint">
              {runs.map((r) => (
                <li key={r.at}>
                  {runLine(r)}
                  {r.summary ? `: ${r.summary}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ui-hint">It has not run yet.</p>
          )}
          {detail.files.length > 0 && (
            <details className="panel-details">
              <summary>Files ({detail.files.length})</summary>
              <ul className="ui-hint">
                {detail.files.map((f) => (
                  <li key={f.path}>{f.path}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="ui-field">
            <label htmlFor="skill-text" className="ui-field__label">
              SKILL.md
            </label>
            <textarea
              id="skill-text"
              className="ui-input ui-input--multi ui-input--mono"
              rows={16}
              spellCheck={false}
              readOnly={!editing}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {problems.length > 0 && (
            <ul className="ui-hint" aria-label="Problems found" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="panel-row">
            {editing ? (
              <>
                <Button variant="primary" onClick={save}>
                  Save
                </Button>
                <Button
                  onClick={() => {
                    setText(detail.text)
                    setEditing(false)
                    setProblems([])
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button icon={icons.settings} onClick={() => setEditing(true)}>
                {s.origin === 'user' ? 'Edit' : 'Edit a copy'}
              </Button>
            )}
          </div>
          {editing && s.origin !== 'user' && (
            <p className="ui-hint">
              Saving puts your copy in your skills folder; it replaces the one that came with Lumen.
            </p>
          )}
        </>
      )}
    </Card>
  )
}

function SkillRow({
  s,
  onOpen,
  onChanged
}: {
  s: SkillSummary
  onOpen: () => void
  onChanged: () => void
}): JSX.Element {
  const toggle = async (on: boolean): Promise<void> => {
    await window.lumen.invoke('skills:set-enabled', s.name, on)
    announce(`${s.name} ${on ? 'on' : 'off'}`)
    onChanged()
  }
  const trust = async (on: boolean): Promise<void> => {
    await window.lumen.invoke('skills:set-trusted', s.name, on)
    announce(on ? `${s.name} trusted` : `${s.name} untrusted`)
    onChanged()
  }
  const exportIt = async (): Promise<void> => {
    const r = await window.lumen.invoke('skills:export', s.name)
    if (r.ok) announce(`Saved to ${r.path}`)
    else if (r.error !== 'cancelled') announce(`Not saved: ${r.error}`, 'assertive')
  }
  const [confirming, setConfirming] = useState(false)
  const remove = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      announce(`Press delete again to delete ${s.name}. This cannot be undone.`, 'assertive')
      return
    }
    setConfirming(false)
    const r = await window.lumen.invoke('skills:delete', s.name)
    if (r.ok) announce(`Deleted ${s.name}`)
    else announce(`Not deleted: ${r.error}`, 'assertive')
    onChanged()
  }
  const community = s.trust === 'community-untrusted' || s.trust === 'community-trusted'

  return (
    <li className="panel-list__item">
      <div className="panel-list__text">
        <span className="panel-list__title">{s.name}</span>
        <span className="ui-hint">{s.description}</span>
        <span className="ui-hint">
          {skillMeta(s)} · {permissionLines(s.permissions, s.apps).join('; ')}
        </span>
      </div>
      <Switch
        checked={s.enabled}
        onChange={toggle}
        label={<span className="visually-hidden">Use {s.name}</span>}
      />
      {community && (
        <IconButton
          icon={icons.shield}
          label={s.trust === 'community-trusted' ? `Stop trusting ${s.name}` : `Trust ${s.name}`}
          pressed={s.trust === 'community-trusted'}
          onClick={() => trust(s.trust !== 'community-trusted')}
        />
      )}
      <IconButton icon={icons.eye} label={`View ${s.name}`} onClick={onOpen} />
      <IconButton icon={icons.external} label={`Export ${s.name}`} onClick={exportIt} />
      {s.origin === 'user' && (
        <IconButton
          icon={icons.trash}
          label={confirming ? `Press again to delete ${s.name}` : `Delete ${s.name}`}
          variant="danger"
          onClick={remove}
          onBlur={() => setConfirming(false)}
        />
      )}
    </li>
  )
}

function NewSkill({ onCreated }: { onCreated: (name: string) => void }): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [msg, setMsg] = useState('')
  const valid = NAME_RE.test(name)
  const create = async (): Promise<void> => {
    const r = await window.lumen.invoke('skills:create', name, description.trim())
    if (r.ok) {
      announce(`Created ${name}`)
      setMsg('')
      setName('')
      setDescription('')
      onCreated(name)
    } else {
      setMsg(r.error)
      announce(`Not created: ${r.error}`, 'assertive')
    }
  }
  return (
    <Card
      title="New skill"
      description="A skill is a short set of instructions in plain words. Lumen loads it when your request fits."
    >
      <div className="panel-row panel-row--end">
        <div className="ui-field">
          <label htmlFor="skill-new-name" className="ui-field__label">
            Name (lowercase words joined by -)
          </label>
          <input
            id="skill-new-name"
            className="ui-input"
            value={name}
            placeholder="tidy-desktop"
            aria-invalid={name !== '' && !valid}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
          />
        </div>
        <div className="ui-field">
          <label htmlFor="skill-new-desc" className="ui-field__label">
            What it does
          </label>
          <input
            id="skill-new-desc"
            className="ui-input"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Button disabled={!valid} onClick={create}>
          Create
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

export function Skills(): JSX.Element {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.lumen
      .invoke('skills:list')
      .then(setSkills)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const shown = filterSkills(skills, query)
  const groups: [string, SkillSummary[]][] = [
    ['Yours', shown.filter((s) => s.trust === 'mine')],
    ['Community', shown.filter((s) => s.trust.startsWith('community'))],
    ['Built in', shown.filter((s) => s.trust === 'builtin')]
  ]

  return (
    <>
      {open && (
        <SkillEditor key={open} name={open} onClose={() => setOpen(null)} onSaved={refresh} />
      )}
      <Card
        title="Skills"
        description="Abilities Lumen can use, like “clean my downloads”. Only names and descriptions go to the AI until a skill is used. Switch off any you do not want."
      >
        <div className="panel-search">
          <icons.search />
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <p className="ui-hint" aria-live="polite">
          {query ? `${shown.length} of ${skills.length} skills` : `${skills.length} skills`}
        </p>
        {groups
          .filter(([, list]) => list.length > 0)
          .map(([label, list]) => (
            <section key={label} aria-label={label}>
              <h3>{label}</h3>
              <ul className="panel-list">
                {list.map((s) => (
                  <SkillRow key={s.name} s={s} onOpen={() => setOpen(s.name)} onChanged={refresh} />
                ))}
              </ul>
            </section>
          ))}
        {!shown.length && <p className="ui-hint">{query ? 'No matches.' : 'No skills yet.'}</p>}
        <p className="ui-hint">
          Trust levels: {Object.values(TRUST_LABEL).join(', ')}. Untrusted community skills ask
          before every action.
        </p>
      </Card>
      <SkillsCompose
        onSaved={(name) => {
          refresh()
          setOpen(name)
        }}
      />
      <NewSkill
        onCreated={(name) => {
          refresh()
          setOpen(name)
        }}
      />
      <SkillsInstall onInstalled={refresh} />
    </>
  )
}
