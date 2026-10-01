// Spring physics, fades and FLIP for the whole UI. Only transform/opacity are animated.
// Under reduced motion every helper jumps straight to the end state.

export interface SpringPreset {
  stiffness: number
  damping: number
  mass: number
}

export const SPRINGS = {
  /** Bar resize, card height, highlight move. ζ ≈ 0.97 */
  snappy: { stiffness: 520, damping: 44, mass: 1 },
  /** Buddy flight, panel slide. ζ ≈ 0.93 */
  glide: { stiffness: 260, damping: 30, mass: 1 },
  /** Buddy follow-cursor. ζ ≈ 1.0 */
  follow: { stiffness: 900, damping: 60, mass: 1 }
} satisfies Record<string, SpringPreset>

export type SpringName = keyof typeof SPRINGS

export const DURATION = { instant: 80, fast: 140, base: 200, slow: 260 } as const
export const EASE = {
  out: 'cubic-bezier(0.2, 0, 0, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  inOut: 'cubic-bezier(0.4, 0, 0.2, 1)'
} as const

const SUBSTEP = 1 / 240
const REST = 0.01
const MAX_FRAME = 1 / 15

export interface SpringState {
  x: number[]
  v: number[]
}

/** Advances a spring by `dt` seconds in fixed semi-implicit Euler substeps. */
export function stepSpring(
  s: SpringState,
  target: number[],
  p: SpringPreset,
  dt: number
): SpringState {
  const x = s.x.slice()
  const v = s.v.slice()
  let remaining = Math.min(dt, MAX_FRAME)
  while (remaining > 1e-9) {
    const h = Math.min(SUBSTEP, remaining)
    for (let i = 0; i < x.length; i++) {
      const force = -p.stiffness * (x[i] - target[i]) - p.damping * v[i]
      v[i] += (force / p.mass) * h
      x[i] += v[i] * h
    }
    remaining -= h
  }
  return { x, v }
}

export function atRest(s: SpringState, target: number[]): boolean {
  return s.x.every((x, i) => Math.abs(x - target[i]) < REST && Math.abs(s.v[i]) < REST * 10)
}

export function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return false
  const flag = document.documentElement.dataset.reduceMotion
  if (flag === 'true') return true
  if (flag === 'false') return false
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export interface Clock {
  now: () => number
  frame: (cb: () => void) => number
  cancel: (id: number) => void
}

const browserClock = (): Clock => ({
  now: () => performance.now(),
  frame: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id)
})

export interface SpringHandle {
  /** Moves the target without resetting velocity, so mid-flight changes stay smooth. */
  retarget: (to: number[]) => void
  cancel: () => void
  readonly done: Promise<void>
}

export interface SpringOptions {
  from: number[]
  to: number[]
  preset?: SpringName | SpringPreset
  velocity?: number[]
  onFrame: (values: number[]) => void
  reduced?: boolean
  clock?: Clock
}

export function animateSpring(o: SpringOptions): SpringHandle {
  const preset = typeof o.preset === 'string' ? SPRINGS[o.preset] : (o.preset ?? SPRINGS.snappy)
  const clock = o.clock ?? browserClock()
  let target = o.to.slice()
  let state: SpringState = { x: o.from.slice(), v: o.velocity?.slice() ?? o.from.map(() => 0) }
  let id = 0
  let finished = false
  let resolve: () => void = () => {}
  const done = new Promise<void>((r) => (resolve = r))
  const finish = (): void => {
    if (finished) return
    finished = true
    resolve()
  }

  if (o.reduced ?? prefersReducedMotion()) {
    o.onFrame(target)
    finish()
    return {
      retarget: (to) => o.onFrame(to.slice()),
      cancel: finish,
      done
    }
  }

  let last = clock.now()
  const tick = (): void => {
    const now = clock.now()
    state = stepSpring(state, target, preset, (now - last) / 1000)
    last = now
    if (atRest(state, target)) {
      state = { x: target.slice(), v: target.map(() => 0) }
      o.onFrame(state.x)
      finish()
      return
    }
    o.onFrame(state.x)
    id = clock.frame(tick)
  }
  id = clock.frame(tick)

  return {
    retarget: (to) => {
      target = to.slice()
      if (finished) {
        finished = false
        last = clock.now()
        id = clock.frame(tick)
      }
    },
    cancel: () => {
      clock.cancel(id)
      finish()
    },
    done
  }
}

function play(
  el: HTMLElement,
  frames: Keyframe[],
  duration: number,
  easing: string
): Promise<void> {
  if (prefersReducedMotion() || !el.animate) {
    const lastFrame = frames[frames.length - 1]
    if (lastFrame.opacity !== undefined) el.style.opacity = String(lastFrame.opacity)
    return Promise.resolve()
  }
  const a = el.animate(frames, { duration, easing, fill: 'forwards' })
  return a.finished.then(
    () => {
      if (lastOpacity(frames) !== undefined) el.style.opacity = String(lastOpacity(frames))
      a.cancel()
    },
    () => {}
  )
}

const lastOpacity = (frames: Keyframe[]): Keyframe['opacity'] => frames[frames.length - 1].opacity

/** Fade (and optionally lift by `shift` px) into view. */
export function fadeIn(el: HTMLElement, shift = 8): Promise<void> {
  return play(
    el,
    [
      { opacity: 0, transform: `translateY(${shift}px)` },
      { opacity: 1, transform: 'none' }
    ],
    DURATION.base,
    EASE.out
  )
}

/** Exits are ~70% of the enter duration; `scale` shrinks it on the way out (the bar: 0.96). */
export function fadeOut(el: HTMLElement, shift = 8, scale = 1): Promise<void> {
  return play(
    el,
    [
      { opacity: 1, transform: 'none' },
      {
        opacity: 0,
        transform: `translateY(${shift}px)${scale === 1 ? '' : ` scale(${scale})`}`
      }
    ],
    DURATION.fast,
    EASE.in
  )
}

/**
 * FLIP: measures `el`, runs `mutate`, then springs it from the old box to the new one
 * using transform only.
 */
export function flip(
  el: HTMLElement,
  mutate: () => void,
  preset: SpringName = 'snappy'
): SpringHandle | null {
  const before = el.getBoundingClientRect()
  mutate()
  const after = el.getBoundingClientRect()
  if (!after.width || !after.height) return null
  const dx = before.left - after.left
  const dy = before.top - after.top
  const sx = before.width / after.width
  const sy = before.height / after.height
  if (
    Math.abs(dx) < 0.5 &&
    Math.abs(dy) < 0.5 &&
    Math.abs(sx - 1) < 0.005 &&
    Math.abs(sy - 1) < 0.005
  )
    return null
  el.style.transformOrigin = '0 0'
  return animateSpring({
    from: [dx, dy, sx, sy],
    to: [0, 0, 1, 1],
    preset,
    onFrame: ([x, y, a, b]) => {
      el.style.transform =
        x === 0 && y === 0 && a === 1 && b === 1
          ? ''
          : `translate(${x}px, ${y}px) scale(${a}, ${b})`
    }
  })
}

/**
 * A CSS `linear()` easing plus duration that trace a spring from 0 to 1, so plain CSS
 * transitions can share the spring presets.
 */
export function springCss(name: SpringName): { easing: string; durationMs: number } {
  const p = SPRINGS[name]
  const dt = 1 / 120
  let s: SpringState = { x: [0], v: [0] }
  const samples = [0]
  let t = 0
  while (!atRest(s, [1]) && t < 2) {
    s = stepSpring(s, [1], p, dt)
    samples.push(Math.round(s.x[0] * 1000) / 1000)
    t += dt
  }
  samples[samples.length - 1] = 1
  const stride = Math.max(1, Math.ceil(samples.length / 40))
  const picked = samples.filter((_, i) => i % stride === 0 || i === samples.length - 1)
  return { easing: `linear(${picked.join(', ')})`, durationMs: Math.round(t * 1000) }
}
