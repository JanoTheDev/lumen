// Ways to choose before the user's own setup exists: resting the pointer (dwell) and a
// single switch (auto-scan moves focus, Space or Enter picks). Both stop for good once the
// user clicks or uses Tab, so mouse and keyboard users are never surprised.
import { useEffect, useRef, type RefObject } from 'react'
import { announce } from '../../ui'

const DWELL_MS = 1200
const DWELL_RADIUS = 16
const SCAN_IDLE_MS = 5000
const SCAN_STEP_MS = 1500

/** Elements marked `data-choose` inside `root` are clicked after the pointer rests on them. */
export function useDwellChoose(root: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const el = root.current
    if (!el || !enabled) return
    let off = false
    let target: HTMLElement | null = null
    let fired: HTMLElement | null = null
    let start = { x: 0, y: 0 }
    let timer: ReturnType<typeof setTimeout> | null = null

    const clear = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      target?.classList.remove('is-dwelling')
      target = null
    }
    const onMove = (e: PointerEvent): void => {
      if (off) return
      const hit = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-choose]') ?? null
      if (hit !== fired) fired = null
      if (!hit || hit === fired) return clear()
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > DWELL_RADIUS
      if (hit === target && !moved) return
      clear()
      target = hit
      start = { x: e.clientX, y: e.clientY }
      // Restart the CSS fill animation.
      void hit.offsetWidth
      hit.classList.add('is-dwelling')
      timer = setTimeout(() => {
        fired = hit
        clear()
        hit.click()
      }, DWELL_MS)
    }
    // A real click means the user can click; dwell would only get in the way.
    const onDown = (e: PointerEvent): void => {
      if (e.isTrusted) {
        off = true
        clear()
      }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', clear)
    el.addEventListener('pointerdown', onDown)
    return () => {
      clear()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', clear)
      el.removeEventListener('pointerdown', onDown)
    }
  }, [root, enabled])
}

/** After 5 s without input, focus steps through `[data-choose]` and `[data-scan]` elements. */
export function useAutoScan(root: RefObject<HTMLElement | null>, enabled: boolean): void {
  const stopped = useRef(false)
  useEffect(() => {
    const el = root.current
    if (!el || !enabled) return
    let idle: ReturnType<typeof setTimeout> | null = null
    let step: ReturnType<typeof setInterval> | null = null
    let index = -1

    const items = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>('[data-choose], [data-scan]')).filter(
        (n) => !(n as HTMLButtonElement).disabled
      )
    const stopScan = (): void => {
      if (step) clearInterval(step)
      step = null
    }
    const startScan = (): void => {
      if (stopped.current || step) return
      announce('Scanning. Press Space or Enter to choose.')
      step = setInterval(() => {
        const list = items()
        if (!list.length) return
        index = (index + 1) % list.length
        list[index].focus()
      }, SCAN_STEP_MS)
    }
    const arm = (): void => {
      if (idle) clearTimeout(idle)
      if (!stopped.current) idle = setTimeout(startScan, SCAN_IDLE_MS)
    }
    const stopForGood = (): void => {
      stopped.current = true
      stopScan()
      if (idle) clearTimeout(idle)
    }
    const onKey = (e: KeyboardEvent): void => {
      // Space/Enter are the switch; anything else is a keyboard user.
      if (e.key === ' ' || e.key === 'Enter') {
        if (!step) arm()
        return
      }
      stopForGood()
    }
    const onPointer = (e: PointerEvent): void => {
      if (e.type === 'pointerdown' || Math.abs(e.movementX) + Math.abs(e.movementY) > 8) {
        stopForGood()
      }
    }
    arm()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('pointermove', onPointer, true)
    return () => {
      stopScan()
      if (idle) clearTimeout(idle)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('pointermove', onPointer, true)
    }
  }, [root, enabled])
}

/** Reads text with the local Windows voice (free, offline). Skipped when a screen reader runs. */
export function speak(text: string): void {
  if (typeof speechSynthesis === 'undefined') return
  speechSynthesis.cancel()
  speechSynthesis.speak(new SpeechSynthesisUtterance(text))
}

export function stopSpeaking(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}
