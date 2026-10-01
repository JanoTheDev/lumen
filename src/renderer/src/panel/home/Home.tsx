// Home flyout (tray): status, ask box, suggestions, recent questions and quick toggles.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { HomeInfo, LessonProgressView } from '@shared/channels'
import { IconButton, Kbd, Switch, icons } from '../../ui'
import { animateSpring } from '../../ui/motion'
import { invoke, send, useIpc } from '../../lib/ipc'
import { useConfig } from '../settings/useConfig'
import { DEFAULT_SUGGESTIONS, moveIndex } from './suggestions'

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

/** The lesson to continue (07 T22); refreshed whenever Home opens. */
function useLearning(): [LessonProgressView['active'], () => void] {
  const [active, setActive] = useState<LessonProgressView['active']>(null)
  const refresh = useCallback((): void => {
    invoke('teach:progress')
      .then((p) => setActive(p.active))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  return [active, refresh]
}

function run(text: string): void {
  const t = text.trim()
  if (t) send('home:run', t)
}

export function Home(): JSX.Element {
  const [info, refresh] = useHomeInfo()
  const [lesson, refreshLesson] = useLearning()
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

      {lesson && (
        <section className="home-section" aria-labelledby="home-learn">
          <h2 id="home-learn" className="home-label">
            Continue learning
          </h2>
          <button
            type="button"
            className="home-recent__item home-learn"
            onClick={() => {
              void invoke('teach:start', lesson.lessonId).catch(() => {})
              send('panel:close')
            }}
          >
            <icons.book />
            <span className="home-learn__text">
              <span className="home-learn__title">{lesson.title}</span>
              <span className="home-learn__meta">
                {lesson.appName} · {lesson.running ? 'now on' : 'stopped at'} step {lesson.step} of{' '}
                {lesson.total}
              </span>
            </span>
          </button>
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
