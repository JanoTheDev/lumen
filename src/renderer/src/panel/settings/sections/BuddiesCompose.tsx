// "Make a buddy for me" (08 T51/T53): describe it in your own words, Lumen's AI writes a draft,
// and you review and change it here (name, look, instructions, what it may do, model, budget,
// report, skills, helpers, schedule) before it is saved as your own buddy.
import { useEffect, useRef, useState } from 'react'
import type { BuddyComposePreview } from '@shared/buddies'
import type { BuddyEditable } from '@shared/buddy-views'
import { Button, Card, Field, announce } from '../../../ui'
import { BuddiesFields } from './BuddiesFields'
import { draftToSave, editableOf, formProblems } from './buddies-view'

type Ready = Extract<BuddyComposePreview, { ok: true }>

interface Said {
  ok: boolean
  text: string
  /** The phrase it is about (a later edit hides it). */
  for: string
}

async function sayWhen(text: string): Promise<Said | null> {
  const phrase = text.trim()
  if (phrase.length < 2) return null
  const r = await window.lumen.invoke('buddies:schedule-parse', phrase).catch(() => null)
  if (!r) return null
  return r.ok
    ? { ok: true, text: `Runs ${r.description}.`, for: phrase }
    : { ok: false, text: r.error, for: phrase }
}

/** The schedule phrase with what Lumen understood, checked as you leave the field. */
export function WhenField({
  value,
  onChange,
  label = 'When it runs',
  hint = 'Like “every weekday at 8” or “when a PDF lands in Downloads”. Leave empty to run it only when you ask.'
}: {
  value: string
  onChange: (v: string) => void
  label?: string
  hint?: string
}): JSX.Element {
  // What Lumen understood, for the text it was checked on.
  const [said, setSaid] = useState<Said | null>(null)
  const check = (text: string): void => void sayWhen(text).then((s) => s && setSaid(s))
  useEffect(() => {
    // The draft's own phrase is checked once; later ones on blur.
    let alive = true
    void sayWhen(value).then((s) => alive && s && setSaid(s))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const shown = said && said.for === value.trim() ? said : null
  return (
    <Field label={label} hint={hint} error={shown && !shown.ok ? shown.text : undefined}>
      {(a) => (
        <>
          <input
            {...a}
            className="ui-input"
            type="text"
            maxLength={120}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => check(value)}
          />
          {shown?.ok && (
            <span className="ui-hint" role="status">
              {shown.text}
            </span>
          )}
        </>
      )}
    </Field>
  )
}

export function BuddiesCompose({
  onSaved,
  autoFocus
}: {
  onSaved: (id: string) => void
  autoFocus?: boolean
}): JSX.Element {
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [draft, setDraft] = useState<Ready | null>(null)
  const [form, setForm] = useState<BuddyEditable | null>(null)
  const [when, setWhen] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])
  useEffect(() => {
    if (draft) headingRef.current?.focus()
  }, [draft])

  const write = async (): Promise<void> => {
    setBusy(true)
    setMsg('Writing the buddy…')
    setProblems([])
    announce('Writing the buddy')
    try {
      const r = await window.lumen.invoke('buddies:compose', { description: description.trim() })
      if (r.ok) {
        setDraft(r)
        setForm(editableOf(r.draft))
        setWhen(r.draft.schedule?.text ?? '')
        setMsg('')
        announce(`Draft ${r.draft.name} ready to review`)
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
    if (!draft || !form) return
    const bad = formProblems(form)
    if (bad.length) {
      setProblems(bad)
      announce(bad[0], 'assertive')
      return
    }
    setBusy(true)
    try {
      const r = await window.lumen.invoke('buddies:compose-save', {
        draft: draftToSave(form, when, draft.draft.schedule)
      })
      if (r.ok) {
        announce(`Saved ${r.name}`)
        setDraft(null)
        setForm(null)
        setDescription('')
        setMsg(`Saved ${r.name}.`)
        onSaved(r.id)
      } else {
        setProblems([r.error])
        announce(`Not saved: ${r.error}`, 'assertive')
      }
    } catch {
      setProblems(['Not saved: something went wrong'])
    } finally {
      setBusy(false)
    }
  }

  const discard = (): void => {
    setDraft(null)
    setForm(null)
    setProblems([])
    setMsg('Draft discarded.')
    announce('Draft discarded')
  }

  return (
    <Card
      title="Make a buddy for me"
      description="Say what it should do, like “every weekday at 8 sum up new mail and flag anything from my boss”. Lumen writes the buddy; you check it before it is saved."
    >
      {!draft && (
        <>
          <div className="ui-field">
            <label htmlFor="buddy-compose" className="ui-field__label">
              What should the buddy do?
            </label>
            <textarea
              id="buddy-compose"
              ref={inputRef}
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
              busy={busy}
              disabled={busy || description.trim().length < 4}
              onClick={write}
            >
              {busy ? 'Writing…' : 'Write it for me'}
            </Button>
          </div>
        </>
      )}
      {draft && form && (
        <section aria-label={`Draft ${form.name || draft.draft.name}`} className="bd-review">
          <h3 ref={headingRef} tabIndex={-1}>
            Draft: {form.name || draft.draft.name}
          </h3>
          {draft.warnings.length > 0 && (
            <ul aria-label="Notes" className="ui-hint">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <BuddiesFields value={form} onChange={setForm} />
          <WhenField value={when} onChange={setWhen} />
          {problems.length > 0 && (
            <ul className="ui-hint" aria-label="Problems found" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="panel-row">
            <Button variant="primary" busy={busy} disabled={busy} onClick={save}>
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
