// The bar's background, split into a top cap, a stretchable body and a bottom cap so a height
// change can spring with transforms only: the caps keep their rounded corners while the body
// scales. Content is laid out at its final size immediately and clipped to the moving top
// edge, so nothing pokes out while the surface grows. Rows that move because a row appeared
// or left below them glide to their new place (FLIP with a spring) instead of jumping; a row
// that grew is clipped at its old bottom while it glides, so it never draws over the rows
// below it.
//
// Compact (status only: listening, thinking with nothing else to show) the surface is a short
// pill; the width springs between the two. During that spring the content keeps its final
// width, centred and clipped to the moving sides, so text never re-wraps frame by frame.
//
// Children marked `data-morph-skip` (absolutely placed overlays) are not rows.
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { animateSpring, prefersReducedMotion, type SpringHandle } from '../ui/motion'
import { rowGlide, type RowBox } from './bar-timing'

const CAP = 16

export interface MorphSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  ref?: Ref<HTMLDivElement>
  /** Short pill width (CSS `.as-morph.is-compact`). */
  compact?: boolean
}

interface Clip {
  /** Content hidden above the drawn top edge (growing). */
  top: number
  /** Content hidden beyond each drawn side (widening). */
  side: number
}

export function MorphSurface({
  children,
  className,
  ref,
  compact = false,
  ...rest
}: MorphSurfaceProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const clip = useRef<Clip>({ top: 0, side: 0 })
  // Laid-out width after the last change, the drawn width while springing, the running spring.
  const width = useRef({ last: -1, now: -1, spring: null as SpringHandle | null })

  const applyClip = (): void => {
    const el = contentRef.current
    if (!el) return
    const { top, side } = clip.current
    el.style.clipPath =
      top > 0.01 || side > 0.01 ? `inset(${Math.max(0, top)}px ${side}px 0 ${side}px)` : ''
  }

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    let shown = -1
    let layout = 0
    let spring: SpringHandle | null = null
    // Each row's distance from the card's bottom edge (the card is anchored at the bottom) and
    // its height, to know how much it grew.
    const rows = new Map<HTMLElement, RowBox>()
    const rowSprings = new Map<HTMLElement, { handle: SpringHandle; y: number; grew: number }>()

    const flipRows = (animate: boolean): void => {
      const content = contentRef.current
      if (!content) return
      const h = content.offsetHeight
      const measured: Array<[HTMLElement, RowBox]> = []
      for (const child of Array.from(content.children)) {
        const el = child as HTMLElement
        if (el.dataset.morphSkip !== undefined) continue
        measured.push([el, { d: h - el.offsetTop, h: el.offsetHeight }])
      }
      const seen = new Set<HTMLElement>()
      for (const [el, now] of measured) {
        seen.add(el)
        const before = rows.get(el)
        rows.set(el, now)
        if (!animate) continue
        const running = rowSprings.get(el)
        const glide = rowGlide(before, now, running)
        if (!glide) continue
        running?.handle.cancel()
        const entry = { handle: null as unknown as SpringHandle, y: glide.from, grew: glide.grew }
        entry.handle = animateSpring({
          from: [glide.from],
          to: [0],
          preset: 'snappy',
          onFrame: ([y]) => {
            entry.y = y
            const still = Math.abs(y) >= 0.05
            el.style.translate = still ? `0 ${y}px` : ''
            // A row shifted down draws past its final bottom by up to y: hide the new part.
            const hide = still ? Math.min(Math.max(0, y), entry.grew) : 0
            el.style.clipPath = hide > 0.05 ? `inset(0 0 ${hide}px 0)` : ''
          }
        })
        rowSprings.set(el, entry)
        void entry.handle.done.then(() => {
          if (rowSprings.get(el) === entry) rowSprings.delete(el)
        })
      }
      for (const el of Array.from(rows.keys())) {
        if (seen.has(el)) continue
        rows.delete(el)
        rowSprings.get(el)?.handle.cancel()
        rowSprings.delete(el)
      }
    }

    const paint = (h: number): void => {
      shown = h
      // Distance of the drawn top edge from the laid-out one: + while growing, - while shrinking.
      const lift = layout - h
      const bodyFull = Math.max(1, layout - 2 * CAP)
      const scale = Math.max(0, h - 2 * CAP) / bodyFull
      const moving = Math.abs(lift) > 0.01
      if (topRef.current) topRef.current.style.transform = moving ? `translateY(${lift}px)` : ''
      if (bodyRef.current) bodyRef.current.style.transform = moving ? `scaleY(${scale})` : ''
      clip.current.top = lift
      applyClip()
    }

    const ro = new ResizeObserver((entries) => {
      // Sizes from the observer's entry (offset sizes only where it has none).
      const size = entries[entries.length - 1]?.borderBoxSize?.[0]
      const h = size ? size.blockSize : box.offsetHeight
      if (!width.current.spring) width.current.last = size ? size.inlineSize : box.offsetWidth
      // A width spring changes only the width; the height logic has nothing to do.
      if (Math.abs(h - layout) < 0.5 && shown >= 0) return
      layout = h
      flipRows(shown >= 0 && !prefersReducedMotion())
      if (shown < 0 || prefersReducedMotion()) {
        spring?.cancel()
        spring = null
        paint(layout)
        return
      }
      if (Math.abs(shown - layout) < 0.5 && !spring) {
        paint(layout)
        return
      }
      if (spring) {
        spring.retarget([layout])
        return
      }
      const s = animateSpring({
        from: [shown],
        to: [layout],
        preset: 'snappy',
        onFrame: ([v]) => paint(v)
      })
      spring = s
      void s.done.then(() => {
        if (spring === s) spring = null
      })
    })
    ro.observe(box)
    return () => {
      ro.disconnect()
      spring?.cancel()
      rowSprings.forEach((r) => r.handle.cancel())
    }
  }, [])

  // Width: spring from the old width to the new one when `compact` flips.
  useLayoutEffect(() => {
    const box = boxRef.current
    const content = contentRef.current
    const w = width.current
    if (!box || !content) return
    const from = w.spring ? w.now : w.last
    w.spring?.cancel()
    w.spring = null
    box.style.width = ''
    content.style.width = ''
    content.style.translate = ''
    const target = box.offsetWidth
    w.last = target
    const reset = (): void => {
      box.style.width = ''
      content.style.width = ''
      content.style.translate = ''
      clip.current.side = 0
      applyClip()
    }
    if (from < 0 || Math.abs(from - target) < 0.5 || prefersReducedMotion()) {
      reset()
      return
    }
    content.style.width = `${target}px`
    const s = animateSpring({
      from: [from],
      to: [target],
      preset: 'snappy',
      onFrame: ([v]) => {
        w.now = v
        box.style.width = `${v}px`
        content.style.translate = `${(v - target) / 2}px 0`
        clip.current.side = Math.max(0, (target - v) / 2)
        applyClip()
      }
    })
    w.spring = s
    void s.done.then(() => {
      if (w.spring !== s) return
      w.spring = null
      reset()
    })
    return () => s.cancel()
  }, [compact])

  const classes = ['as-morph', compact && 'is-compact', className].filter(Boolean).join(' ')
  return (
    <div
      ref={(el) => {
        boxRef.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) (ref as { current: HTMLDivElement | null }).current = el
      }}
      className={classes}
      {...rest}
    >
      <div className="as-morph__bg" aria-hidden="true">
        <div ref={topRef} className="as-morph__top" />
        <div ref={bodyRef} className="as-morph__body" />
        <div className="as-morph__bottom" />
      </div>
      <div ref={contentRef} className="as-morph__content">
        {children}
      </div>
    </div>
  )
}
