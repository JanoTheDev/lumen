// Small animated pieces of the assistant bar. Everything animates transform/opacity only and
// falls back to instant changes under reduced motion (the global CSS gate plus motion.ts).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Markdown } from '../ui'
import { prefersReducedMotion } from '../ui/motion'
import { revealText, smoothLevel } from './model'

/** Keeps children mounted for their exit fade, then unmounts them. */
export function Fade({
  show,
  children,
  className
}: {
  show: boolean
  children: ReactNode
  className?: string
}): JSX.Element | null {
  const [state, setState] = useState<'in' | 'out' | 'gone'>(show ? 'in' : 'gone')
  const [kept, setKept] = useState<ReactNode>(children)
  if (show && state !== 'in') setState('in')
  if (show && kept !== children) setKept(children)
  if (!show && state === 'in') setState('out')

  useEffect(() => {
    if (state !== 'out') return
    const t = window.setTimeout(() => setState('gone'), 110)
    return () => window.clearTimeout(t)
  }, [state])

  if (state === 'gone') return null
  return (
    <div
      className={`as-fade ${state === 'out' ? 'is-leaving' : ''} ${className ?? ''}`}
      aria-hidden={state === 'out' || undefined}
    >
      {show ? children : kept}
    </div>
  )
}

/** The status text: the old line slides out while the new one fades in (40ms overlap). */
export function CrossFadeText({ text, shimmer }: { text: string; shimmer?: boolean }): JSX.Element {
  const [lines, setLines] = useState<{ id: number; text: string }[]>([{ id: 0, text }])
  const last = lines[lines.length - 1]
  if (last.text !== text) setLines([last, { id: last.id + 1, text }])

  useEffect(() => {
    if (lines.length < 2) return
    const t = window.setTimeout(() => setLines((l) => l.slice(-1)), 120)
    return () => window.clearTimeout(t)
  }, [lines])

  return (
    <span className="as-status__text" aria-live="off">
      {lines.map((l, i) => (
        <span
          key={l.id}
          className={
            i < lines.length - 1
              ? 'as-xfade is-old'
              : `as-xfade is-new${shimmer ? ' as-shimmer' : ''}`
          }
        >
          {l.text}
        </span>
      ))}
    </span>
  )
}

const BAR_SHAPE = [0.55, 0.85, 1, 0.8, 0.5]

/**
 * Five bars driven by the voice level (`--voice-level` on :root, 0..1, written by the voice
 * module without React). Each bar is smoothed (attack 30ms, release 120ms). One bar under
 * reduced motion.
 */
export function LevelMeter({ active }: { active: boolean }): JSX.Element {
  const bars = useRef<Array<HTMLSpanElement | null>>([])
  const reduced = prefersReducedMotion()
  const count = reduced ? 1 : BAR_SHAPE.length

  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    const levels = BAR_SHAPE.map(() => 0)
    let raf = 0
    let last = performance.now()
    const frame = (): void => {
      const now = performance.now()
      const dt = now - last
      last = now
      const raw = parseFloat(root.style.getPropertyValue('--voice-level'))
      const target = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
      for (let i = 0; i < count; i++) {
        levels[i] = smoothLevel(levels[i], target * (reduced ? 1 : BAR_SHAPE[i]), dt)
        const el = bars.current[i]
        if (el) el.style.transform = `scaleY(${0.18 + 0.82 * levels[i]})`
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [active, count, reduced])

  return (
    <span className="as-meter" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          className="as-meter__bar"
        />
      ))}
    </span>
  )
}

/** "2 of 5" where the changing number rolls up instead of popping. */
export function RollingNumber({ value }: { value: number }): JSX.Element {
  const [items, setItems] = useState([{ v: value, key: 0 }])
  const top = items[items.length - 1]
  if (top.v !== value) setItems([top, { v: value, key: top.key + 1 }])
  useEffect(() => {
    if (items.length < 2) return
    const t = window.setTimeout(() => setItems((l) => l.slice(-1)), 170)
    return () => window.clearTimeout(t)
  }, [items])
  return (
    <span className="as-roll tabular">
      {items.map((it, i) => (
        <span
          key={it.key}
          className={items.length > 1 ? (i === 0 ? 'is-out' : 'is-in') : undefined}
          aria-hidden={i < items.length - 1 || undefined}
        >
          {it.v}
        </span>
      ))}
    </span>
  )
}

/**
 * The answer, rendered as Markdown from the first word: while streaming, whole words appear
 * and fade in (opacity only, each already holds its place), and the final render lays out the
 * same text, so the card never jumps when the answer completes.
 */
export function AnswerText({
  markdown,
  streaming,
  onLink
}: {
  markdown: string
  streaming: boolean
  onLink: (url: string) => void
}): JSX.Element {
  return (
    <div className="as-answer__md">
      <Markdown source={revealText(markdown, streaming)} streaming={streaming} onLink={onLink} />
    </div>
  )
}
