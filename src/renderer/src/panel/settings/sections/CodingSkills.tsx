// Settings → Claude Code → Coding skills: the library (from docs, imported, written), the draft
// under review (warnings, update diff, editable SKILL.md), and the skills each project uses.
// Sessions Lumen starts load a project's skills from a Lumen folder; nothing is written into
// the project unless "Save to the project" is pressed.
import { useCallback, useEffect, useState } from 'react'
import type { ClaudeProject } from '@shared/claude-code'
import type {
  CodingSkillDraft,
  CodingSkillsOverview,
  CodingSkillsProject
} from '@shared/coding-skills'
import { Button, Card, Field, announce, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'

function Input({
  label,
  hint,
  value,
  placeholder,
  onChange,
  multiline
}: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
  multiline?: boolean
}): JSX.Element {
  return (
    <Field label={label} hint={hint}>
      {(a) =>
        multiline ? (
          <textarea
            {...a}
            className="ui-input ui-input--multi"
            rows={4}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            {...a}
            className="ui-input"
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      }
    </Field>
  )
}

function sourceText(s: CodingSkillsOverview['library'][number]['source']): string {
  if (s.kind === 'docs') return `from ${s.urls[0] ?? 'docs'}`
  if (s.kind === 'import') return `imported from ${s.from}`
  return 'written by you'
}

function DraftCard({
  draft,
  done
}: {
  draft: CodingSkillDraft
  done: (msg: string, ok?: boolean) => void
}): JSX.Element {
  // The parent keys this card by the draft, so a new draft starts a fresh text.
  const [text, setText] = useState(draft.skillMd)
  const save = async (): Promise<void> => {
    const r = await invoke('claude:skills-save', {
      id: draft.id,
      ...(text !== draft.skillMd ? { skillMd: text } : {})
    })
    done(r.ok ? `Saved the ${draft.title} skill.` : (r.error ?? 'Could not save it.'), r.ok)
  }
  const discard = async (): Promise<void> => {
    await invoke('claude:skills-discard')
    done('Discarded.')
  }
  const unchanged = draft.update && !draft.update.changed && text === draft.skillMd
  return (
    <div className="panel-stack" role="region" aria-label={`Review the ${draft.title} skill`}>
      <p>
        <strong>
          {draft.update ? 'Update' : 'New skill'}: {draft.title}
        </strong>{' '}
        <span className="ui-hint">
          ({draft.name}
          {draft.version ? `, version ${draft.version}` : ''})
        </span>
      </p>
      <p className="ui-hint">{draft.description}</p>
      {draft.warnings.map((w) => (
        <div key={w} className="panel-note" role="alert">
          <icons.alert />
          <span>Check this: it {w}</span>
        </div>
      ))}
      {draft.update && (
        <pre className="ui-input ui-input--mono" tabIndex={0} aria-label="Changes">
          {draft.update.changed ? draft.update.diff : '(no changes)'}
        </pre>
      )}
      <Field label="SKILL.md" hint="This is what Claude Code reads. You can edit it before saving.">
        {(a) => (
          <textarea
            {...a}
            className="ui-input ui-input--mono"
            rows={14}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      <div className="panel-row">
        <Button
          variant="primary"
          icon={icons.check}
          disabled={!!unchanged}
          onClick={() => void save()}
        >
          {draft.update ? 'Save the update' : 'Save the skill'}
        </Button>
        <Button variant="quiet" onClick={() => void discard()}>
          Discard
        </Button>
      </div>
    </div>
  )
}

export function CodingSkills({ projects }: { projects: ClaudeProject[] }): JSX.Element {
  const [ov, setOv] = useState<CodingSkillsOverview | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [docsTitle, setDocsTitle] = useState('')
  const [docsUrl, setDocsUrl] = useState('')
  const [importFrom, setImportFrom] = useState('')
  const [writeTitle, setWriteTitle] = useState('')
  const [writeText, setWriteText] = useState('')
  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null)
  const [picked, setPicked] = useState('')
  const [info, setInfo] = useState<CodingSkillsProject | null>(null)
  const [confirmCopy, setConfirmCopy] = useState('')

  const refresh = useCallback(() => {
    invoke('claude:skills')
      .then(setOv)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  // A draft made by voice shows up here while the page is open.
  useEffect(() => {
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  const project = picked || projects[0]?.path || ''
  const loadProject = useCallback((path: string) => {
    if (!path) return
    invoke('claude:skills-project', path)
      .then((r) => setInfo('error' in r ? null : r))
      .catch(() => {})
  }, [])
  useEffect(() => loadProject(project), [project, loadProject, ov?.library.length])

  const say = (text: string, ok = true): void => {
    setMsg(text)
    announce(text, ok ? 'polite' : 'assertive')
  }
  const done = (text: string, ok = true): void => {
    say(text, ok)
    refresh()
    loadProject(project)
  }

  const run = async (
    label: string,
    work: () => Promise<{ ok: boolean; error?: string }>
  ): Promise<void> => {
    setBusy(label)
    setMsg('')
    try {
      const r = await work()
      if (r.ok) say('Ready to review below.')
      else say(r.error ?? 'That did not work.', false)
    } finally {
      setBusy('')
      refresh()
    }
  }

  const attach = async (names: string[]): Promise<void> => {
    const r = await invoke('claude:skills-attach', { project, names })
    if (!('error' in r)) setInfo(r)
    say('error' in r ? r.error : 'Attached. Claude loads it from its next turn.', !('error' in r))
  }

  const detach = async (name: string): Promise<void> => {
    const r = await invoke('claude:skills-detach', { project, name })
    if (!('error' in r)) setInfo(r)
  }

  const copyToProject = async (name: string): Promise<void> => {
    if (confirmCopy !== name) return setConfirmCopy(name)
    setConfirmCopy('')
    const r = await invoke('claude:skills-save-to-project', { project, name })
    say(r.ok ? `Copied to ${r.path}.` : (r.error ?? 'Could not copy it.'), r.ok)
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const r = await invoke('claude:skills-edit', { name: editing.name, skillMd: editing.text })
    say(r.ok ? 'Saved.' : (r.error ?? 'Could not save it.'), r.ok)
    if (r.ok) setEditing(null)
    refresh()
  }

  if (!ov) return <p className="ui-hint">Loading coding skills…</p>
  const titleOf = (n: string): string => ov.library.find((s) => s.name === n)?.title ?? n

  return (
    <>
      <Card
        title="Coding skills"
        description="Reference notes Claude Code reads while it codes: one per library or convention. Lumen keeps them in its own folder and hands a project’s skills to the sessions it starts there. Say “add a skill for better-auth from https://…”, “use the Next.js skill for this project” or “what skills is Claude using here”."
      >
        {ov.draft && (
          <DraftCard
            key={`${ov.draft.id}:${ov.draft.skillMd.length}`}
            draft={ov.draft}
            done={done}
          />
        )}
        <div className="panel-stack">
          <strong>From docs</strong>
          <Input
            label="Library"
            value={docsTitle}
            placeholder="Better Auth"
            onChange={setDocsTitle}
          />
          <Input
            label="Docs link"
            hint="An https page of the library’s docs. Leave empty for well-known libraries."
            value={docsUrl}
            placeholder="https://www.better-auth.com/docs/installation"
            onChange={setDocsUrl}
          />
          <div className="panel-row">
            <Button
              busy={busy === 'docs'}
              disabled={!!busy || (!docsUrl.trim() && !docsTitle.trim())}
              icon={icons.book}
              onClick={() =>
                void run('docs', () =>
                  invoke('claude:skills-from-docs', {
                    ...(docsUrl.trim() ? { url: docsUrl.trim() } : {}),
                    ...(docsTitle.trim() ? { title: docsTitle.trim() } : {}),
                    ...(project ? { project } : {})
                  })
                )
              }
            >
              Read the docs and write a skill
            </Button>
          </div>
        </div>
        <div className="panel-stack">
          <strong>Import a Claude skill</strong>
          <Input
            label="Folder or GitHub link"
            value={importFrom}
            placeholder="https://github.com/owner/repo/tree/main/skills/pdf"
            onChange={setImportFrom}
          />
          <div className="panel-row">
            <Button
              icon={icons.download}
              disabled={!!busy}
              onClick={() => void invoke('claude:pick-folder').then((p) => p && setImportFrom(p))}
            >
              Pick a folder
            </Button>
            <Button
              busy={busy === 'import'}
              disabled={!!busy || !importFrom.trim()}
              onClick={() =>
                void run('import', () =>
                  invoke('claude:skills-import', {
                    from: importFrom.trim(),
                    ...(project ? { project } : {})
                  })
                )
              }
            >
              Import
            </Button>
          </div>
        </div>
        <div className="panel-stack">
          <strong>Write your own</strong>
          <Input
            label="Name"
            value={writeTitle}
            placeholder="Our API conventions"
            onChange={setWriteTitle}
          />
          <Input
            label="What Claude should know"
            multiline
            value={writeText}
            placeholder="Routes live in src/api; always validate input with zod; …"
            onChange={setWriteText}
          />
          <div className="panel-row">
            <Button
              busy={busy === 'write'}
              disabled={!!busy || !writeTitle.trim() || !writeText.trim()}
              icon={icons.sparkles}
              onClick={() =>
                void run('write', () =>
                  invoke('claude:skills-write', {
                    title: writeTitle.trim(),
                    text: writeText.trim(),
                    ...(project ? { project } : {})
                  })
                )
              }
            >
              Write the skill
            </Button>
          </div>
        </div>
        {msg && (
          <p className="ui-hint" role="status">
            {msg}
          </p>
        )}
      </Card>

      <Card title="Skill library" description={`Saved in ${ov.dir}.`}>
        {ov.library.length === 0 && <p className="ui-hint">No coding skills yet.</p>}
        <ul className="panel-list">
          {ov.library.map((s) => (
            <li key={s.name} className="panel-stack">
              <span>
                <strong>{s.title}</strong>{' '}
                <span className="ui-hint">
                  {s.name}
                  {s.version ? ` · ${s.version}` : ''} · {sourceText(s.source)} · updated{' '}
                  {new Date(s.updatedAt).toLocaleDateString()}
                </span>
              </span>
              <span className="ui-hint">{s.description}</span>
              {editing?.name === s.name ? (
                <>
                  <Field label={`SKILL.md of ${s.title}`}>
                    {(a) => (
                      <textarea
                        {...a}
                        className="ui-input ui-input--mono"
                        rows={14}
                        spellCheck={false}
                        value={editing.text}
                        onChange={(e) => setEditing({ name: s.name, text: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="panel-row">
                    <Button variant="primary" onClick={() => void saveEdit()}>
                      Save
                    </Button>
                    <Button variant="quiet" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <div className="panel-row">
                  {s.source.kind !== 'written' && (
                    <Button
                      icon={icons.repeat}
                      busy={busy === `update:${s.name}`}
                      disabled={!!busy}
                      onClick={() =>
                        void run(`update:${s.name}`, () => invoke('claude:skills-update', s.name))
                      }
                    >
                      Check for changes
                    </Button>
                  )}
                  <Button
                    onClick={() =>
                      void invoke('claude:skills-read', s.name).then(
                        (r) => r.ok && setEditing({ name: s.name, text: r.skillMd ?? '' })
                      )
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    variant="quiet"
                    icon={icons.trash}
                    aria-label={`Delete ${s.title}`}
                    onClick={() =>
                      void invoke('claude:skills-remove', s.name).then(() => done('Deleted.'))
                    }
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Skills per project"
        description="The skills Claude uses in each project. They load from Lumen’s folder for sessions Lumen starts; your repository is not changed."
      >
        <Field label="Project">
          {(a) => (
            <select
              {...a}
              className="ui-select"
              value={project}
              onChange={(e) => setPicked(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {info && info.path === project && (
          <>
            {info.attached.length === 0 && <p className="ui-hint">No skills attached.</p>}
            <ul className="panel-list">
              {info.attached.map((n) => (
                <li key={n} className="panel-row">
                  <span>
                    <strong>{titleOf(n)}</strong> <span className="ui-hint">/lumen-skills:{n}</span>
                  </span>
                  <Button variant="quiet" onClick={() => void detach(n)}>
                    Remove
                  </Button>
                  <Button variant="quiet" onClick={() => void copyToProject(n)}>
                    {confirmCopy === n ? 'Copy into .claude/skills?' : 'Save to the project'}
                  </Button>
                </li>
              ))}
            </ul>
            {ov.library.some((s) => !info.attached.includes(s.name)) && (
              <Field label="Add from the library">
                {(a) => (
                  <select
                    {...a}
                    className="ui-select"
                    value=""
                    onChange={(e) => e.target.value && void attach([e.target.value])}
                  >
                    <option value="">Choose a skill…</option>
                    {ov.library
                      .filter((s) => !info.attached.includes(s.name))
                      .map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.title}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            )}
            {info.suggestions.length > 0 && (
              <div className="panel-stack">
                <strong>Suggested for this project</strong>
                {info.suggestions.map((sg) => (
                  <div key={sg.name} className="panel-row">
                    <span>
                      {sg.title} <span className="ui-hint">({sg.reason})</span>
                    </span>
                    {sg.inLibrary ? (
                      <Button onClick={() => void attach([sg.name])}>Use it</Button>
                    ) : (
                      <Button
                        disabled={!!busy}
                        busy={busy === `sug:${sg.name}`}
                        onClick={() =>
                          void run(`sug:${sg.name}`, () =>
                            invoke('claude:skills-from-docs', {
                              title: sg.title,
                              ...(sg.docsUrl ? { url: sg.docsUrl } : {}),
                              project
                            })
                          )
                        }
                      >
                        Write it from the docs
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}
