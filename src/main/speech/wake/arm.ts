// Voice-cancel phrases ("stop", "cancel") are only listened for while an action or a plan
// runs, never while the user is speaking a request. Ref-counted: nested/parallel runs share it.

type Listener = (armed: boolean) => void

let count = 0
const listeners = new Set<Listener>()

function notify(armed: boolean): void {
  for (const fn of listeners) fn(armed)
}

export function cancelArmed(): boolean {
  return count > 0
}

export function onCancelArmed(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Arms cancel phrases; call the returned function once to disarm. */
export function armCancel(): () => void {
  count++
  if (count === 1) notify(true)
  let done = false
  return () => {
    if (done) return
    done = true
    count--
    if (count === 0) notify(false)
  }
}

export async function withCancelArmed<T>(fn: () => Promise<T>): Promise<T> {
  const disarm = armCancel()
  try {
    return await fn()
  } finally {
    disarm()
  }
}
