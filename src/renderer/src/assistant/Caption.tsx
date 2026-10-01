// Caption ("I heard: …"), its editor, the feedback line and the bar's own live regions
// (06 T11 / T14). Main decides what is announced: lines a screen reader or TTS already said
// arrive with `audible` and are only shown; the rest are announced here, once.
import { useEffect, useId, useRef, useState } from 'react'
import type { AssistantView } from '@shared/channels'
import { Button, icons, type IconComponent } from '../ui'
import { send } from '../lib/ipc'
import { Fade } from './parts'

type Live = NonNullable<AssistantView['live']>
type Edit = NonNullable<AssistantView['captionEdit']>

/** The caption row. Its text is a polite live region; the Edit button sits outside it. */
export function CaptionRow({ caption }: { caption?: string }): JSX.Element {
  return (
    <div className={`as-caption-wrap${caption ? '' : ' is-empty'}`}>
      <div className="as-caption-slot" aria-live="polite" aria-atomic="true">
        <Fade show={!!caption}>
          {caption && (
            <p className="as-row as-caption">
              <span className="as-caption__label">I heard</span>
              <span className="as-caption__text">“{caption}”</span>
            </p>
          )}
        </Fade>
      </div>
      {caption && (
        <Button
          variant="quiet"
          className="as-caption__edit"
          aria-label="Edit what I heard"
          onClick={() => send('assistant:command', { type: 'edit' })}
        >
          Edit
        </Button>
      )}
    </div>
  )
}

const EDIT_COPY: Record<Edit['mode'], { label: string; hint: string }> = {
  edit: {
    label: 'Correct what I heard',
    hint: 'Type or say the right words. Enter runs it, Esc cancels.'
  },
  spell: {
    label: 'Spell it',
    hint: 'Say letters, like “h e l l o” or “hotel echo”. Say “done” or press Enter to run it.'
  }
}

/** Inline editor for a correction; Enter runs the text as a new utterance. Keyed by mode. */
export function CaptionEditor({ edit }: { edit: Edit }): JSX.Element {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(edit.draft)
  // Spelled letters and dictation come from main; typing edits the same text.
  const [fromMain, setFromMain] = useState(edit.draft)
  if (fromMain !== edit.draft) {
    setFromMain(edit.draft)
    setValue(edit.draft)
  }
  useEffect(() => input.current?.focus(), [])
  const copy = EDIT_COPY[edit.mode]
  const submit = (): void => {
    const text = value.trim()
    if (text) send('assistant:correct', text)
  }
  return (
    <form
      className="as-row as-edit"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="as-edit__label" htmlFor={`${id}-in`}>
        {copy.label}
      </label>
      <div className="as-edit__row">
        <input
          ref={input}
          id={`${id}-in`}
          className="ui-input"
          value={value}
          maxLength={4000}
          spellCheck
          aria-describedby={`${id}-h`}
          data-caption-input=""
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            send('assistant:command', { type: 'edit-cancel' })
          }}
        />
        <Button type="submit" variant="primary" disabled={!value.trim()}>
          Run
        </Button>
        <Button onClick={() => send('assistant:command', { type: 'edit-cancel' })}>Cancel</Button>
      </div>
      <p id={`${id}-h`} className="ui-hint">
        {copy.hint}
      </p>
    </form>
  )
}

const LIVE_ICON: Record<string, IconComponent> = {
  focus: icons.pointer,
  scan: icons.toggle,
  step: icons.chevronRight,
  command: icons.check,
  answer: icons.message
}

/** What Lumen said (or would have said): a calm line above the bar, not a live region. */
export function FeedbackLine({ live }: { live: Live }): JSX.Element {
  const Icon = LIVE_ICON[live.kind] ?? icons.info
  return (
    <p className="as-row as-live">
      <span className="as-live__icon">
        <Icon />
      </span>
      <span className="as-live__text">{live.text}</span>
    </p>
  )
}

/**
 * Visually hidden live regions for lines nobody voiced. Text is cleared first so a repeat is
 * read again. Each line (id) is announced at most once, also when a screen reader declined it
 * after it was shown.
 */
export function BarLive({ live }: { live?: Live }): JSX.Element {
  const polite = useRef<HTMLDivElement>(null)
  const assertive = useRef<HTMLDivElement>(null)
  const said = useRef(new Set<number>())
  const id = live?.id
  const text = live && !live.audible ? live.text : undefined
  const loud = !!live?.assertive
  useEffect(() => {
    if (id === undefined || text === undefined || said.current.has(id)) return
    const el = (loud ? assertive : polite).current
    if (!el) return
    el.textContent = ''
    const t = window.setTimeout(() => {
      el.textContent = text
      said.current.add(id)
      if (said.current.size > 50) said.current.delete(said.current.values().next().value as number)
    }, 50)
    return () => window.clearTimeout(t)
  }, [id, text, loud])
  return (
    <div className="visually-hidden">
      <div ref={polite} aria-live="polite" aria-atomic="true" />
      <div ref={assertive} aria-live="assertive" aria-atomic="true" />
    </div>
  )
}
