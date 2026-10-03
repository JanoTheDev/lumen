// One task's chat (08 T43): status header with Stop / Pause / Resume / Run again, the live
// transcript, a confirm card for a waiting OK, and the composer that steers the task.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatControlOp, ChatDelta, ChatHeader, ChatView } from '@shared/task-chat'
import { announce, Button, icons, Toast } from '../../ui'
import { prefersReducedMotion } from '../../ui/motion'
import { invoke, useIpc } from '../../lib/ipc'
import { ChatEntries } from './ChatEntries'
import { costLine } from '../settings/sections/usage-view'
import { useTaskCosts } from '../settings/sections/use-usage-cost'
import {
  announcement,
  applyBuffered,
  applyDelta,
  composerHint,
  composerLabel,
  followScroll,
  headerFacts,
  type FollowMark,
  isLive,
  PHASE_TEXT
} from './chat-view'

function useChat(id: string): {
  view: ChatView | null
  state: 'loading' | 'ready' | 'missing'
} {
  const [view, setView] = useState<ChatView | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  const title = useRef('')
  /** Deltas that arrive before the snapshot (null once it is in). */
  const early = useRef<ChatDelta[] | null>([])
  useEffect(() => {
    // The pane is keyed by id, so a new task starts from the loading state.
    let alive = true
    early.current = []
    // Live pushes only while this view is open; watching first means no change falls between
    // the snapshot and the first push.
    invoke('tasks:watch', id, true)
      .catch(() => {})
      .then(() => invoke('tasks:chat', id))
      .then((v) => {
        if (!alive) return
        if (v && 'header' in v) {
          setView(applyBuffered(v, early.current ?? []))
          setState('ready')
        } else setState('missing')
        early.current = null
      })
      .catch(() => alive && setState('missing'))
    return () => {
      alive = false
      void invoke('tasks:watch', id, false).catch(() => {})
    }
  }, [id])
  useEffect(() => {
    if (view) title.current = view.header.title
  }, [view])
  useIpc('tasks:chat-delta', (d) => {
    if (d.id !== id) return
    if (early.current) {
      early.current.push(d)
      return
    }
    setView((v) => applyDelta(v, d))
    for (const e of d.entries ?? []) {
      const line = announcement(e, title.current || 'Task')
      if (line) announce(line)
    }
  })
  return { view, state }
}

/** Ticks once a second while the task runs (the elapsed time). */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [live])
  return now
}

/** The facts line owns the clock, so the tick re-renders only this line. */
function HeaderFacts({ h, usage }: { h: ChatHeader; usage: string }): JSX.Element {
  const now = useNow(isLive(h.phase) && !h.endedAt)
  return (
    <p className="chat-head__facts">
      <span className={`chat-phase is-${h.phase}`}>{PHASE_TEXT[h.phase]}</span>
      {h.project && <span> · {h.project}</span>}
      <span> · {headerFacts(h, now)}</span>
      {usage && <span> · Usage {usage}</span>}
    </p>
  )
}

function Controls({
  h,
  onControl
}: {
  h: ChatHeader
  onControl: (op: ChatControlOp) => void
}): JSX.Element | null {
  if (!h.canStop && !h.canPause && !h.canResume && !h.canRunAgain) return null
  return (
    <div className="chat-head__actions" role="group" aria-label="Task controls">
      {h.canPause && (
        <Button icon={icons.pause} onClick={() => onControl('pause')}>
          Pause
        </Button>
      )}
      {h.canResume && (
        <Button icon={icons.play} variant="primary" onClick={() => onControl('resume')}>
          Resume
        </Button>
      )}
      {h.canStop && (
        <Button icon={icons.square} variant="danger" onClick={() => onControl('stop')}>
          Stop
        </Button>
      )}
      {h.canRunAgain && (
        <Button icon={icons.repeat} onClick={() => onControl('run-again')}>
          Run again
        </Button>
      )}
    </div>
  )
}

function Composer({
  h,
  onSend
}: {
  h: ChatHeader
  onSend: (text: string) => Promise<boolean>
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const disabled = !h.canSteer && !h.question
  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    void onSend(text).then((ok) => {
      setBusy(false)
      if (ok) setDraft('')
    })
  }
  return (
    <form className="chat-composer" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="chat-input">
        {composerLabel(h)}
      </label>
      <textarea
        id="chat-input"
        className="ui-input chat-composer__input"
        rows={2}
        maxLength={2000}
        placeholder={disabled ? composerHint(h) : `${composerLabel(h)}…`}
        aria-describedby="chat-input-hint"
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <Button
        type="submit"
        variant="primary"
        icon={icons.play}
        busy={busy}
        disabled={disabled || !draft.trim()}
      >
        Send
      </Button>
      <p id="chat-input-hint" className="ui-hint chat-composer__hint">
        {composerHint(h)} Enter sends, Shift+Enter starts a new line.
      </p>
    </form>
  )
}

export function ChatPane({ id }: { id: string }): JSX.Element {
  const { view, state } = useChat(id)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const follow = useRef<FollowMark>({ count: 0, last: undefined, at: 0 })
  const h = view?.header
  const token = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    token.current = h?.question?.token
  })
  // Ledger spend with helpers (05 T44); Claude sessions are billed to the user's own plan.
  const usage = costLine(
    useTaskCosts(h && h.kind !== 'claude' ? [id] : [], `${h?.modelCalls}|${h?.phase}`)[id]
  )

  // Focus lands on the task's name when another task opens.
  useEffect(() => {
    if (state === 'ready') heading.current?.focus()
  }, [id, state])

  // Stays at the newest entry unless the user scrolled up to read; follows only a new or
  // changed newest row, not a row that changed in place further up.
  const entries = view?.entries
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !entries) return
    const now = performance.now()
    const behavior = followScroll(follow.current, entries, now, prefersReducedMotion())
    if (!behavior) return
    follow.current = { count: entries.length, last: entries[entries.length - 1], at: now }
    if (pinned.current) el.scrollTo({ top: el.scrollHeight, behavior })
  }, [entries])

  const onControl = useCallback(
    (op: ChatControlOp, token?: string) => {
      void invoke('tasks:control', { id, op, ...(token ? { token } : {}) })
        .then((r) => {
          if (!r || !('ok' in r) || !r.ok) {
            const why = r && 'error' in r && r.error
            setNotice({ kind: 'error', text: why || 'That did not work. The task may have ended.' })
            return
          }
          setNotice(null)
          if (op === 'run-again' && r.id) location.hash = `#/tasks/${r.id}`
          if (op === 'run-again' && !r.id)
            setNotice({ kind: 'info', text: 'Started again on the assistant bar.' })
        })
        .catch(() => setNotice({ kind: 'error', text: 'That did not work.' }))
    },
    [id]
  )

  const onSend = useCallback(
    async (text: string, token?: string): Promise<boolean> => {
      try {
        const r = await invoke('tasks:steer', { id, text, ...(token ? { token } : {}) })
        if (r && 'ok' in r && r.ok) {
          const said =
            r.how === 'answer'
              ? 'Answer sent.'
              : r.how === 'sent'
                ? 'Sent to Claude.'
                : 'Sent. The task reads it before its next step.'
          // The toast is a status region: it reads the line out.
          setNotice({ kind: 'info', text: said })
          return true
        }
        const why = (r && 'error' in r && r.error) || 'The task did not take the message.'
        setNotice({ kind: 'error', text: why })
        return false
      } catch {
        setNotice({ kind: 'error', text: 'The message was not sent.' })
        return false
      }
    },
    [id]
  )

  const onChoice = useCallback((c: string) => void onSend(c, token.current), [onSend])

  if (state === 'loading') return <p className="ui-hint chat-empty">Loading…</p>
  if (!view || !h)
    return (
      <div className="chat-empty">
        <h1 ref={heading} tabIndex={-1}>
          Task not found
        </h1>
        <p className="ui-hint">It may have been cleared from the list.</p>
      </div>
    )

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-head__text">
          <h1 ref={heading} tabIndex={-1} className="chat-head__title">
            {h.title}
          </h1>
          <HeaderFacts h={h} usage={usage} />
        </div>
        <Controls h={h} onControl={onControl} />
      </header>
      {h.confirm && (
        <div className="chat-card chat-confirm" role="alertdialog" aria-label="Needs your OK">
          <p className="chat-card__label">
            <icons.shield /> Needs your OK
          </p>
          <p>{h.confirm}</p>
          <div className="chat-question__choices">
            <Button variant="primary" onClick={() => onControl('approve', h.confirmId)}>
              Allow
            </Button>
            <Button onClick={() => onControl('deny', h.confirmId)}>Deny</Button>
          </div>
        </div>
      )}
      <div
        className="chat-scroll"
        ref={scroller}
        tabIndex={0}
        aria-label="Transcript"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <ChatEntries entries={view.entries} header={h} dropped={view.dropped} onChoice={onChoice} />
      </div>
      {notice && (
        <Toast kind={notice.kind} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Toast>
      )}
      <Composer h={h} onSend={(text) => onSend(text, h.question?.token)} />
    </div>
  )
}
