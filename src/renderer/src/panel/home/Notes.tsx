// Home Notes (04 T45): "take a note …", dictation with no text field, "save to notes" and
// notes typed here. Copy, edit and delete each one.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Note } from '@shared/dictation-history'
import { Button, IconButton, icons } from '../../ui'
import { invoke, useIpc } from '../../lib/ipc'
import { noteMeta } from './dictation-view'

const SHOWN = 5

function useNotes(): [Note[], () => void] {
  const [notes, setNotes] = useState<Note[]>([])
  const refresh = useCallback((): void => {
    invoke('notes:list')
      .then((list) => Array.isArray(list) && setNotes(list))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useIpc('home:shown', refresh)
  return [notes, refresh]
}

function NoteItem({ note, refresh }: { note: Note; refresh: () => void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.text)
  const [copied, setCopied] = useState(false)
  const save = (e: FormEvent): void => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    void invoke('notes:update', note.id, text)
      .then(refresh)
      .catch(() => {})
    setEditing(false)
  }
  if (editing)
    return (
      <li className="home-note">
        <form className="home-note__edit" onSubmit={save}>
          <textarea
            className="ui-input"
            aria-label="Edit note"
            rows={3}
            maxLength={10_000}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setEditing(false)
                setDraft(note.text)
              }
            }}
          />
          <span className="home-note__actions">
            <Button type="submit" variant="quiet" disabled={!draft.trim()}>
              Save
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        </form>
      </li>
    )
  return (
    <li className="home-note">
      <button
        type="button"
        className="home-note__body"
        aria-label={`Edit note: ${note.text.slice(0, 80)}`}
        onClick={() => {
          setDraft(note.text)
          setEditing(true)
        }}
      >
        <span className="home-note__text">{note.text}</span>
        <span className="home-note__meta">{noteMeta(note)}</span>
      </button>
      <span className="home-note__actions">
        <IconButton
          icon={copied ? icons.check : icons.copy}
          label={copied ? 'Copied' : 'Copy note'}
          onClick={() => {
            void invoke('notes:copy', note.id)
              .then((r) => {
                if (!r?.ok) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }}
        />
        <IconButton
          icon={icons.trash}
          label="Delete note"
          variant="danger"
          onClick={() => {
            void invoke('notes:delete', note.id)
              .then(refresh)
              .catch(() => {})
          }}
        />
      </span>
    </li>
  )
}

export function Notes(): JSX.Element {
  const [notes, refresh] = useNotes()
  const [draft, setDraft] = useState('')
  const [all, setAll] = useState(false)
  const add = (e: FormEvent): void => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    void invoke('notes:add', text)
      .then(refresh)
      .catch(() => {})
    setDraft('')
  }
  const shown = all ? notes : notes.slice(0, SHOWN)
  return (
    <section className="home-section" aria-labelledby="home-notes">
      <h2 id="home-notes" className="home-label">
        Notes
      </h2>
      <form className="home-ask" onSubmit={add}>
        <input
          className="ui-input"
          type="text"
          aria-label="New note"
          placeholder="Write a note, or say “take a note …”"
          maxLength={10_000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <IconButton icon={icons.check} label="Add note" type="submit" disabled={!draft.trim()} />
      </form>
      {shown.length > 0 && (
        <ul className="home-notes">
          {shown.map((n) => (
            <NoteItem key={`${n.id}-${n.updated ?? n.t}`} note={n} refresh={refresh} />
          ))}
        </ul>
      )}
      {notes.length > SHOWN && (
        <Button variant="quiet" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${notes.length}`}
        </Button>
      )}
    </section>
  )
}
