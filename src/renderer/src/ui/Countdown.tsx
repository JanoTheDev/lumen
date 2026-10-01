import { useEffect, useRef, useState, type ReactNode } from 'react'
import { announce } from './announce'

export interface CountdownProps {
  durationMs: number
  /** Visible text for the remaining whole seconds, e.g. (s) => `Sending in ${s}`. */
  label: (secondsLeft: number) => string
  onDone: () => void
  onCancel?: () => void
  /** External pause (speaking, pinned). Hover and focus pause it too. */
  paused?: boolean
  children?: ReactNode
}

/** A visual bar plus text. Space pauses, Escape cancels. Announced once at start. */
export function Countdown({
  durationMs,
  label,
  onDone,
  onCancel,
  paused,
  children
}: CountdownProps): JSX.Element {
  const [left, setLeft] = useState(durationMs)
  const [hold, setHold] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const fillRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(onDone)
  const labelRef = useRef(label)
  useEffect(() => {
    doneRef.current = onDone
    labelRef.current = label
  })

  useEffect(() => {
    announce(labelRef.current(Math.ceil(durationMs / 1000)), 'assertive')
  }, [durationMs])

  const running = !paused && !hold && !userPaused && left > 0
  useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    let remaining = left
    const tick = (): void => {
      const now = performance.now()
      remaining = Math.max(0, remaining - (now - last))
      last = now
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${remaining / durationMs})`
      setLeft((prev) => (Math.ceil(prev / 1000) !== Math.ceil(remaining / 1000) ? remaining : prev))
      if (remaining <= 0) {
        setLeft(0)
        doneRef.current()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      setLeft(remaining)
    }
    // `left` seeds the loop only when it (re)starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, durationMs])

  const isPaused = !running && left > 0
  const seconds = Math.ceil(left / 1000)
  return (
    <div
      className={isPaused ? 'ui-countdown is-paused' : 'ui-countdown'}
      onPointerEnter={() => setHold(true)}
      onPointerLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold(false)
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' && e.target === e.currentTarget) {
          e.preventDefault()
          setUserPaused((p) => !p)
        } else if (e.key === 'Escape' && onCancel) {
          e.preventDefault()
          onCancel()
        }
      }}
      tabIndex={-1}
    >
      <div className="ui-countdown__track" aria-hidden="true">
        <div
          ref={fillRef}
          className="ui-countdown__fill"
          style={{ transform: `scaleX(${left / durationMs})` }}
        />
      </div>
      <div className="ui-countdown__row">
        <span role="timer" aria-live="off" className="tabular">
          {label(seconds)}
          {isPaused && ' · Paused'}
        </span>
        {children}
      </div>
    </div>
  )
}
