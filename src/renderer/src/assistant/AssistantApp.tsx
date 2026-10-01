// The assistant bar: one bottom-centre card that grows upward. It renders the AssistantView
// main sends and owns no feature logic. Rows (top to bottom): answer or error, notice,
// confirm, step, feedback line, caption (or its editor), and the bar row that is always there
// while the card is visible.
//
// Screen readers (06 T11): main announces phases, answers, steps, errors and confirms through
// the announce policy, so this window has no shared LiveRegion. Only what nobody voiced is
// announced here (BarLive, the error row's role="alert"); the caption is a polite live region.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AssistantView } from '@shared/channels'
import type { AssistantPhase } from '@shared/events'
import { Button, IconButton, icons, type IconComponent } from '../ui'
import { animateSpring, fadeOut, prefersReducedMotion } from '../ui/motion'
import { send, useIpc } from '../lib/ipc'
import { BarLive, CaptionEditor, CaptionRow, FeedbackLine } from './Caption'
import { Confirm } from './Confirm'
import { MorphSurface } from './MorphSurface'
import { errorHint, statusLine } from './model'
import { AnswerText, CrossFadeText, Fade, LevelMeter, RollingNumber } from './parts'
import { VoiceHost } from './VoiceHost'

const EMPTY: AssistantView = { phase: 'idle', visible: false, autoCloseMs: 0 }

const PHASE_ICON: Record<AssistantPhase, IconComponent> = {
  idle: icons.checkCircle,
  listening: icons.mic,
  transcribing: icons.mic,
  thinking: icons.brain,
  speaking: icons.play,
  acting: icons.click,
  'waiting-user': icons.hand,
  confirm: icons.alert,
  error: icons.error
}

/** Phases where Lumen is still working, so nothing auto-closes. */
const BUSY = new Set<AssistantPhase>(['listening', 'transcribing', 'thinking', 'acting', 'confirm'])

/**
 * Runs the auto-close countdown: a thin line along the top edge, paused while `paused`.
 * Restarts whenever `resetKey` changes. Returns the ref for the line element.
 */
function useAutoClose(
  active: boolean,
  durationMs: number,
  paused: boolean,
  resetKey: string
): React.RefObject<HTMLDivElement | null> {
  const line = useRef<HTMLDivElement>(null)
  const left = useRef(durationMs)
  useEffect(() => {
    left.current = durationMs
    if (line.current) line.current.style.transform = 'scaleX(1)'
  }, [resetKey, durationMs])

  useEffect(() => {
    if (!active || paused || durationMs <= 0) return
    let raf = 0
    let last = performance.now()
    const tick = (): void => {
      const now = performance.now()
      left.current = Math.max(0, left.current - (now - last))
      last = now
      if (line.current) line.current.style.transform = `scaleX(${left.current / durationMs})`
      if (left.current <= 0) {
        send('assistant:command', { type: 'close' })
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, paused, durationMs, resetKey])
  return line
}

export function AssistantApp(): JSX.Element {
  const [view, setView] = useState<AssistantView>(EMPTY)
  // What is drawn: the last visible view, kept while the card plays its exit.
  const [shown, setShown] = useState<AssistantView | null>(null)
  const [hover, setHover] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const shakeRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const wasShown = useRef(false)

  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  })
  useIpc('assistant:state', setView)
  // Main made the window focusable (focus shortcut, a confirm with a screen reader running,
  // the caption editor). Land on the editor, the confirm's default button, else the first
  // control. The state that goes with it may still be rendering, so wait a frame.
  useIpc('assistant:focus', () => {
    window.setTimeout(() => {
      const card = cardRef.current
      if (!card) return
      const confirm = viewRef.current.confirm
      const buttons = card.querySelectorAll<HTMLElement>('.ui-confirm__actions button')
      const el =
        card.querySelector<HTMLElement>('[data-caption-input]') ??
        (confirm && buttons.length
          ? buttons[confirm.risk === 'high' ? 0 : buttons.length - 1]
          : card.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'))
      el?.focus()
    }, 30)
  })
  if (view.visible && shown !== view) setShown(view)
  const hasCard = shown !== null

  // Exit: fade + drop, then unmount so the next show plays the entry again.
  useEffect(() => {
    if (view.visible || !shown) return
    const el = shellRef.current
    let alive = true
    send('assistant:interactive', false)
    const done = (): void => {
      if (!alive) return
      setShown(null)
      // The card unmounts under the pointer or with focus inside: no leave/blur follows,
      // so the next card's countdown would stay paused.
      setHover(false)
      setFocusWithin(false)
    }
    if (el) void fadeOut(el, 8).then(done)
    else done()
    return () => {
      alive = false
    }
  }, [view.visible, shown])

  // Entry: spring from 0.96 scale, 8px down.
  useLayoutEffect(() => {
    const el = shellRef.current
    const isShown = !!shown && view.visible
    if (!isShown) {
      wasShown.current = false
      return
    }
    if (wasShown.current || !el) return
    wasShown.current = true
    el.style.opacity = ''
    el.classList.remove('is-entering')
    void el.offsetWidth
    el.classList.add('is-entering')
    const s = animateSpring({
      from: [0.96, 8],
      to: [1, 0],
      preset: 'snappy',
      onFrame: ([sc, y]) => {
        el.style.transform = sc === 1 && y === 0 ? '' : `translateY(${y}px) scale(${sc})`
      }
    })
    return () => s.cancel()
  }, [shown, view.visible])

  // Card size for main's dwell hit-testing.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      send('assistant:resize', { w: el.offsetWidth, h: el.offsetHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasCard])

  // One gentle shake when a new error appears.
  const errorMsg = shown?.error?.message
  useEffect(() => {
    const el = shakeRef.current
    if (!errorMsg || !el || prefersReducedMotion()) return
    const s = animateSpring({
      from: [0],
      to: [0],
      velocity: [160],
      preset: { stiffness: 600, damping: 22, mass: 1 },
      onFrame: ([x]) => {
        el.style.transform = Math.abs(x) < 0.05 ? '' : `translateX(${x}px)`
      }
    })
    return () => s.cancel()
  }, [errorMsg])

  // A confirm or editor that had focus went away: its blur never fires, so the countdown
  // would stay paused.
  const confirmId = shown?.confirm?.actionId
  const editing = !!shown?.captionEdit
  useEffect(() => {
    if (!cardRef.current?.contains(document.activeElement)) setFocusWithin(false)
  }, [confirmId, editing])

  // Keep the newest streamed words in view.
  const answer = shown?.answer
  useEffect(() => {
    const el = answerRef.current
    if (!el || !answer?.streaming) return
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    })
  }, [answer?.markdown, answer?.streaming])

  const v = shown ?? EMPTY
  const pinned = !!v.answer?.pinned
  const closable = !!(v.answer && !v.answer.streaming) || (!!v.error && v.phase === 'error')
  // A new non-streamed answer in the same turn restarts the countdown too.
  const answerKey = v.answer?.streaming ? '' : v.answer?.markdown
  const resetKey = `${v.answer?.turnId}|${v.answer?.streaming}|${answerKey}|${v.error?.message}`
  const lineRef = useAutoClose(
    view.visible && closable && !BUSY.has(v.phase) && !pinned,
    v.autoCloseMs,
    hover || focusWithin,
    resetKey
  )

  const PhaseIcon = PHASE_ICON[v.phase]
  const listening = v.phase === 'listening'
  const working = v.phase === 'thinking' || v.phase === 'transcribing'
  const hint = v.error ? (v.error.hint ?? errorHint(v.error.message)) : undefined
  const openLink = (url: string): void => send('assistant:open-link', url)
  const command = (type: 'repeat' | 'copy' | 'pin' | 'close'): void =>
    send('assistant:command', { type, turnId: v.answer?.turnId })
  // Keyboard in the bar: Esc closes (or says no to a confirm), arrows scroll the answer.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      send('assistant:command', { type: v.confirm ? 'deny' : 'close' })
      return
    }
    const scroll = answerRef.current
    if (!scroll || e.target === scroll) return
    const step = { ArrowDown: 40, ArrowUp: -40, PageDown: 0.9, PageUp: -0.9 }[e.key]
    if (step === undefined) return
    e.preventDefault()
    const by = Math.abs(step) < 1 ? step * scroll.clientHeight : step
    scroll.scrollBy({ top: by, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  return (
    <>
      <VoiceHost />
      <BarLive live={view.visible ? view.live : undefined} />
      <div className="as-root">
        {hasCard && (
          <div ref={shellRef} className="as-shell">
            <div ref={shakeRef} className="as-shake">
              <MorphSurface
                ref={cardRef}
                role="region"
                aria-label="Lumen"
                className={`as-card is-${v.phase}`}
                onPointerEnter={() => {
                  setHover(true)
                  send('assistant:interactive', true)
                }}
                onPointerLeave={() => {
                  setHover(false)
                  send('assistant:interactive', false)
                }}
                onKeyDown={onKeyDown}
                onFocus={() => setFocusWithin(true)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    setFocusWithin(false)
                }}
              >
                {closable && v.autoCloseMs > 0 && !pinned && (
                  <div className="as-countdown" aria-hidden="true">
                    <div ref={lineRef} className="as-countdown__fill" />
                  </div>
                )}

                <Fade show={!!(v.answer || v.error)}>
                  {v.error && !v.answer ? (
                    <div className="as-row as-error" role={v.error.announced ? undefined : 'alert'}>
                      <p className="as-error__msg">{v.error.message}</p>
                      {hint && <p className="as-error__hint">{hint}</p>}
                    </div>
                  ) : v.answer ? (
                    <div className="as-row as-answer">
                      <div ref={answerRef} className="as-answer__scroll" tabIndex={0}>
                        <AnswerText
                          markdown={v.answer.markdown}
                          streaming={v.answer.streaming}
                          onLink={openLink}
                        />
                      </div>
                      {v.model && <p className="as-answer__meta">{v.model}</p>}
                    </div>
                  ) : null}
                </Fade>

                <Fade show={!!v.notice}>
                  {v.notice && (
                    <div className="as-row as-notice" role="status">
                      <span className="as-notice__text">{v.notice.text}</span>
                      {v.notice.action === 'unmute' && (
                        <Button
                          icon={icons.volume}
                          onClick={() => send('assistant:command', { type: 'unmute' })}
                        >
                          Unmute
                        </Button>
                      )}
                    </div>
                  )}
                </Fade>

                <Fade show={!!v.confirm}>
                  {v.confirm && (
                    <div className="as-row">
                      <Confirm confirm={v.confirm} />
                    </div>
                  )}
                </Fade>

                <Fade show={!!v.step}>
                  {v.step && (
                    <p className="as-row as-step">
                      <span className="as-step__count">
                        Step <RollingNumber value={v.step.index} /> of{' '}
                        <span className="tabular">{v.step.total}</span>
                      </span>
                      <span className="as-step__label">{v.step.label}</span>
                    </p>
                  )}
                </Fade>

                <Fade show={!!v.live && !v.live.echo}>
                  {v.live && <FeedbackLine live={v.live} />}
                </Fade>

                {v.captionEdit ? (
                  <CaptionEditor key={v.captionEdit.mode} edit={v.captionEdit} />
                ) : (
                  <CaptionRow caption={v.caption} />
                )}

                <div className="as-bar">
                  <span className="as-status" role="status">
                    <span className={`as-status__icon is-${v.phase}`}>
                      <PhaseIcon />
                    </span>
                    <CrossFadeText text={statusLine(v)} shimmer={working} />
                    {listening && <LevelMeter active={listening} />}
                  </span>
                  <span className="as-actions">
                    {v.answer && !v.answer.streaming && (
                      <>
                        <IconButton
                          icon={icons.repeat}
                          label="Repeat"
                          onClick={() => command('repeat')}
                        />
                        <IconButton
                          icon={icons.copy}
                          label="Copy"
                          onClick={() => command('copy')}
                        />
                        <IconButton
                          icon={icons.pin}
                          label={pinned ? 'Unpin' : 'Pin'}
                          pressed={pinned}
                          onClick={() => command('pin')}
                        />
                      </>
                    )}
                    <IconButton icon={icons.close} label="Close" onClick={() => command('close')} />
                  </span>
                </div>
              </MorphSurface>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
