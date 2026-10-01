// "Write it for me" (11 F9): describe a skill in your own words, Lumen's AI writes the whole
// SKILL.md (instructions, phrases, what it may do), and you review it here before it is saved:
// the permissions in plain words, the text (editable), extra files and notes. Nothing is
// written until Save; the saved skill is yours.
import { useEffect, useRef, useState } from 'react'
import type { SkillComposePreview } from '@shared/channels'
import { Button, Card, announce } from '../../../ui'
import { permissionLines } from './SkillsText'

type Ready = Extract<SkillComposePreview, { ok: true }>

export function SkillsCompose({ onSaved }: { onSaved: (name: string) => void }): JSX.Element {
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [draft, setDraft] = useState<Ready | null>(null)
  const [text, setText] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (draft) headingRef.current?.focus()
  }, [draft])

  const write = async (): Promise<void> => {
    setBusy(true)
    setMsg('Writing the skill…')
    setProblems([])
    announce('Writing the skill')
    try {
      const r = await window.lumen.invoke('skills:compose', description.trim())
      if (r.ok) {
        setDraft(r)
        setText(r.text)
        setMsg('')
        announce(`Draft ${r.name} ready to review`)
      } else {
        setMsg(`Not written: ${r.error}`)
        announce(`Not written: ${r.error}`, 'assertive')
      }
    } catch {
      setMsg('Not written: something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      const r = await window.lumen.invoke('skills:compose-save', draft.token, text)
      if (r.ok) {
        announce(`Saved ${r.name}`)
        setDraft(null)
        setDescription('')
        setMsg(`Saved ${r.name}.`)
        onSaved(r.name)
      } else {
        setProblems([r.error, ...(r.problems ?? [])])
        announce(`Not saved: ${r.error}`, 'assertive')
      }
    } finally {
      setBusy(false)
    }
  }

  const discard = (): void => {
    setDraft(null)
    setProblems([])
    setMsg('Draft discarded.')
    announce('Draft discarded')
  }

  return (
    <Card
      title="Write a skill for me"
      description="Say what you want in your own words, like “every morning open my mail and read me today’s meetings”. Lumen’s AI writes the skill; you check what it may do before it is saved."
    >
      {!draft && (
        <>
          <div className="ui-field">
            <label htmlFor="skill-compose" className="ui-field__label">
              What should the skill do?
            </label>
            <textarea
              id="skill-compose"
              className="ui-input ui-input--multi"
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="panel-row">
            <Button
              variant="primary"
              disabled={busy || description.trim().length < 4}
              onClick={write}
            >
              {busy ? 'Writing…' : 'Write it for me'}
            </Button>
          </div>
        </>
      )}
      {draft && (
        <section aria-label={`Draft ${draft.name}`}>
          <h3 ref={headingRef} tabIndex={-1}>
            Draft: {draft.name}
          </h3>
          <h4>What it may do</h4>
          <ul>
            {permissionLines(draft.permissions, draft.apps).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {draft.triggers.length > 0 && (
            <p className="ui-hint">Say: {draft.triggers.map((t) => `“${t}”`).join(', ')}</p>
          )}
          {draft.files.length > 0 && (
            <p className="ui-hint">Also saves: {draft.files.join(', ')}</p>
          )}
          {draft.warnings.length > 0 && (
            <ul aria-label="Notes" className="ui-hint">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="ui-field">
            <label htmlFor="skill-compose-text" className="ui-field__label">
              SKILL.md (you can change it before saving)
            </label>
            <textarea
              id="skill-compose-text"
              className="ui-input ui-input--multi ui-input--mono"
              rows={16}
              spellCheck={false}
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
            <Button variant="primary" disabled={busy} onClick={save}>
              Save
            </Button>
            <Button disabled={busy} onClick={discard}>
              Discard
            </Button>
          </div>
        </section>
      )}
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
    </Card>
  )
}
