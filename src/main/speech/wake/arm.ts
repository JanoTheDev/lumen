// Voice-cancel phrases ("stop", "cancel") are only listened for while an action or a plan
// runs, never while the user is speaking a request. Ref-counted: nested/parallel runs share it.

let count = 0

export function cancelArmed(): boolean {
  return count > 0
}

/** Arms cancel phrases; call the returned function once to disarm. */
export function armCancel(): () => void {
  count++
  let done = false
  return () => {
    if (done) return
    done = true
    count--
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
