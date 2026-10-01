// Home flyout (tray): status, ask box, background tasks, suggestions, recent questions and
// quick toggles.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { HomeInfo, LessonProgressView } from '@shared/channels'
import { IconButton, Kbd, Switch, icons } from '../../ui'
import { animateSpring } from '../../ui/motion'
import { invoke, send, useIpc } from '../../lib/ipc'
import { useConfig } from '../settings/useConfig'
import { DEFAULT_SUGGESTIONS, moveIndex } from './suggestions'
import { Tasks } from './Tasks'

function useHomeInfo(): [HomeInfo | null, () => void] {
  const [info, setInfo] = useState<HomeInfo | null>(null)
  const refresh = useCallback((): void => {
    invoke('home:info')
      .then(setInfo)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  return [info, refresh]
}

/** The lesson to continue, up next and due reviews (07 T22, T27-T29); refreshed on open. */
function useLearning(): [LessonProgressView | null, () => void] {
  const [view, setView] = useState<LessonProgressView | null>(null)
  const refresh = useCallback((): void => {
    invoke('teach:progress')
      .then(setView)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  return [view, refresh]
}

interface LearnItem {
  key: string
  title: string
  meta: string
  start: () => Promise<unknown>
}

/** At most three rows: the lesson left part-way, the next lesson of a started app, one review. */
function learnItems(v: LessonProgressView | null): LearnItem[] {
  if (!v) return []
  const out: LearnItem[] = []
  const a = v.active
  if (a)
    out.push({
      key: `a-${a.lessonId}`,
      title: a.title,
      meta: `${a.appName} · ${a.running ? 'now on' : 'stopped at'} step ${a.step} of ${a.total}`,
      start: () => invoke('teach:start', a.lessonId)
    })
  const app = v.apps.find((x) => x.completed > 0 && x.next && x.next.lessonId !== a?.lessonId)
  if (app?.next) {
    const next = app.next
    out.push({
      key: `n-${next.lessonId}`,
      title: next.title,
      meta: `${app.appName} · up next · ${app.completed} of ${app.total} done`,
      start: () => invoke('teach:start', next.lessonId)
    })
  }
  const r = v.reviews[0]
  if (r)
    out.push({
      key: `r-${r.lessonId}`,
      title: `Review: ${r.title}`,
      meta: `${r.appName} · ${v.reviews.length > 1 ? `${v.reviews.length} reviews due` : 'review due'}`,
      start: () => invoke('teach:review', r.lessonId)
    })
  return out
}

function run(text: string): void {
  const t = text.trim()
  if (t) send('home:run', t)
}

export function Home(): JSX.Element {
  const [info, refresh] = useHomeInfo()
  const [learning, refreshLesson] = useLearning()
  const learn = learnItems(learning)
  const { cfg, patch } = useConfig()
  const [ask, setAsk] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [active, setActive] = useState(0)

  const enter = useCallback((): void => {
    const el = rootRef.current
    if (!el) return
    animateSpring({
      from: [12, 0],
      to: [0, 1],
      preset: 'glide',
      onFrame: ([y, o]) => {
        el.style.transform = y ? `translateY(${y}px)` : ''
        el.style.opacity = String(Math.min(1, Math.max(0, o)))
      }
    })
  }, [])

  useIpc('home:shown', () => {
    refresh()
    refreshLesson()
    enter()
    setActive(0)
    cardRefs.current[0]?.focus()
  })
  useIpc('home:ask', () => askRef.current?.focus())

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') send('panel:close')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    run(ask)
    setAsk('')
  }

  const ready = info?.agentReady ?? false
  return (
    <div className="home" ref={rootRef}>
      <header className="home-head">
        <span className="home-title">Lumen</span>
        <span className="home-head__actions">
          <IconButton
            icon={icons.settings}
            label="Settings"
            onClick={() => send('panel:open', 'settings')}
          />
          <IconButton icon={icons.close} label="Close" onClick={() => send('panel:close')} />
        </span>
      </header>

      <p className="home-status" role="status">
        <span className={`home-dot ${ready ? 'is-ready' : ''}`} aria-hidden="true" />
        {ready ? 'Ready' : 'Starting'}
        {info && (
          <>
            <span aria-hidden="true"> · </span>
            Hold <Kbd combo={info.hotkey} /> and talk
          </>
        )}
      </p>

      <form className="home-ask" onSubmit={submit}>
        <input
          ref={askRef}
          className="ui-input"
          type="text"
          aria-label="Ask Lumen"
          placeholder="Ask Lumen…"
          maxLength={2000}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
        />
        <IconButton icon={icons.play} label="Ask" type="submit" disabled={!ask.trim()} />
      </form>

      <Tasks />

      <section className="home-section" aria-labelledby="home-try">
        <h2 id="home-try" className="home-label">
          Try
        </h2>
        <div
          className="home-cards"
          role="group"
          aria-label="Suggestions"
          onKeyDown={(e) => {
            const next = moveIndex(active, e.key, DEFAULT_SUGGESTIONS.length)
            if (next === null) return
            e.preventDefault()
            setActive(next)
            cardRefs.current[next]?.focus()
            cardRefs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          }}
        >
          {DEFAULT_SUGGESTIONS.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                cardRefs.current[i] = el
              }}
              type="button"
              className="home-card"
              tabIndex={i === active ? 0 : -1}
              onFocus={() => setActive(i)}
              onClick={() => run(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      {learn.length > 0 && (
        <section className="home-section" aria-labelledby="home-learn">
          <h2 id="home-learn" className="home-label">
            Continue learning
          </h2>
          <ul className="home-recent">
            {learn.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className="home-recent__item home-learn"
                  onClick={() => {
                    void item.start().catch(() => {})
                    send('panel:close')
                  }}
                >
                  <icons.book />
                  <span className="home-learn__text">
                    <span className="home-learn__title">{item.title}</span>
                    <span className="home-learn__meta">{item.meta}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!info?.recent.length && (
        <section className="home-section" aria-labelledby="home-recent">
          <h2 id="home-recent" className="home-label">
            Recent
          </h2>
          <ul className="home-recent">
            {info.recent.map((r) => (
              <li key={r}>
                <button type="button" className="home-recent__item" onClick={() => run(r)}>
                  <icons.repeat />
                  <span>{r}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {cfg && (
        <section className="home-section home-toggles" aria-label="Quick settings">
          <Switch
            checked={cfg.wakeWord.enabled}
            onChange={(enabled) => patch({ wakeWord: { enabled } })}
            label={`Listen for “${cfg.wakeWord.phrase}”`}
          />
          <Switch
            checked={cfg.dwellClick.enabled}
            onChange={(enabled) => patch({ dwellClick: { enabled } })}
            label="Dwell click"
          />
          <Switch
            checked={cfg.buddy.enabled}
            onChange={(enabled) => patch({ buddy: { enabled } })}
            label="Pointing buddy"
          />
        </section>
      )}
    </div>
  )
}
