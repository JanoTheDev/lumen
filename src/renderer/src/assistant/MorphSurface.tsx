// The bar's background, split into a top cap, a stretchable body and a bottom cap so a height
// change can spring with transforms only: the caps keep their rounded corners while the body
// scales. Content is laid out at its final size immediately and clipped to the moving top
// edge, so nothing pokes out while the surface grows.
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { animateSpring, prefersReducedMotion, type SpringHandle } from '../ui/motion'

const CAP = 16

export interface MorphSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  ref?: Ref<HTMLDivElement>
}

export function MorphSurface({
  children,
  className,
  ref,
  ...rest
}: MorphSurfaceProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    let shown = -1
    let layout = 0
    let spring: SpringHandle | null = null

    const paint = (h: number): void => {
      shown = h
      // Distance of the drawn top edge from the laid-out one: + while growing, - while shrinking.
      const lift = layout - h
      const bodyFull = Math.max(1, layout - 2 * CAP)
      const scale = Math.max(0, h - 2 * CAP) / bodyFull
      const moving = Math.abs(lift) > 0.01
      if (topRef.current) topRef.current.style.transform = moving ? `translateY(${lift}px)` : ''
      if (bodyRef.current) bodyRef.current.style.transform = moving ? `scaleY(${scale})` : ''
      if (contentRef.current)
        contentRef.current.style.clipPath = lift > 0.01 ? `inset(${lift}px 0 0 0)` : ''
    }

    const ro = new ResizeObserver(() => {
      layout = box.offsetHeight
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
        onFrame: ([h]) => paint(h)
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
    }
  }, [])

  return (
    <div
      ref={(el) => {
        boxRef.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) (ref as { current: HTMLDivElement | null }).current = el
      }}
      className={className ? `as-morph ${className}` : 'as-morph'}
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
