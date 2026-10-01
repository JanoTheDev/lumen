// Keeps removed scene items mounted for their exit animation (see scene.ts). `update` is
// called from the IPC handler with the new items; exiting items drop on a timer.
import { useCallback, useEffect, useState } from 'react'
import { nextExpiry, reconcile, type Present } from './scene'

export function usePresence<T>(
  keyOf: (t: T) => string,
  exitMs: number
): [Present<T>[], (items: readonly T[]) => void] {
  const [list, setList] = useState<Present<T>[]>([])
  const update = useCallback(
    (items: readonly T[]) =>
      setList((prev) => reconcile(prev, items, keyOf, performance.now(), exitMs)),
    [keyOf, exitMs]
  )
  useEffect(() => {
    const wait = nextExpiry(list, performance.now(), exitMs)
    if (wait === null) return
    const id = setTimeout(() => {
      setList((prev) =>
        reconcile(
          prev,
          prev.filter((p) => !p.exiting).map((p) => p.item),
          keyOf,
          performance.now(),
          exitMs
        )
      )
    }, wait + 1)
    return () => clearTimeout(id)
  }, [list, keyOf, exitMs])
  return [list, update]
}
