// One CancelScope per user turn (query or renderer-triggered execution). Escape, the voice
// cancel phrase and the cancel IPC all cancel every active scope.

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export class CancelScope {
  private readonly controller = new AbortController()
  private readonly children = new Set<CancelScope>()

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted
  }

  cancel(): void {
    if (this.cancelled) return
    this.controller.abort(new CancelledError())
    for (const c of this.children) c.cancel()
  }

  /** A scope cancelled together with this one (used for parallel subtasks). */
  child(): CancelScope {
    const c = new CancelScope()
    if (this.cancelled) c.cancel()
    else this.children.add(c)
    return c
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError()
  }
}

const active = new Set<CancelScope>()

export function beginScope(): CancelScope {
  const scope = new CancelScope()
  active.add(scope)
  return scope
}

export function endScope(scope: CancelScope): void {
  active.delete(scope)
}

export function hasActiveScope(): boolean {
  return active.size > 0
}

/** Cancels every in-flight turn. Returns true if anything was running. */
export function cancelAll(): boolean {
  const any = active.size > 0
  for (const s of active) s.cancel()
  return any
}

export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: string }).name ?? ''
  return e instanceof CancelledError || name === 'AbortError' || name === 'APIUserAbortError' || name === 'CancelledError'
}
