// Sub-agent pool (08 T49): at most `max()` jobs run at once across every task (Settings →
// agent.subagents.max), outside the background task slots. Jobs past the limit wait in FIFO
// order; an abort takes a waiting job out of the line. Pure.
import { CancelledError } from '../../query/cancel'

export class SubagentPool {
  private active = 0
  private waiting: { go: () => void }[] = []

  constructor(private readonly max: () => number) {}

  /** Jobs running now. */
  get running(): number {
    return this.active
  }

  /** Jobs waiting for a place. */
  get queued(): number {
    return this.waiting.length
  }

  /** Runs `fn` once a place is free (`onStart` right before); rejects if `signal` aborts first. */
  async run<T>(fn: () => Promise<T>, signal: AbortSignal, onStart?: () => void): Promise<T> {
    await this.acquire(signal)
    try {
      onStart?.()
      return await fn()
    } finally {
      this.release()
    }
  }

  private limit(): number {
    return Math.max(1, Math.floor(this.max()) || 1)
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(reason(signal))
    if (this.active < this.limit()) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        go: (): void => {
          signal.removeEventListener('abort', onAbort)
          this.active++
          resolve()
        }
      }
      const onAbort = (): void => {
        this.waiting = this.waiting.filter((w) => w !== entry)
        reject(reason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(entry)
    })
  }

  private release(): void {
    this.active--
    while (this.waiting.length && this.active < this.limit()) this.waiting.shift()!.go()
  }
}

function reason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CancelledError()
}
