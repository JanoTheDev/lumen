// The input lane (08 T25, CONTRACTS C11): Lumen drives one real mouse and keyboard, so real
// input has exactly one holder at a time and input batches never interleave.
//
// Two levels:
//   - `acquire(owner)`: the lane itself, for a whole run (agent mode, a background task's
//     foreground phase). FIFO; other owners wait.
//   - `run(owner, fn)`: one input batch under a short mutex. The holder runs at once; any
//     other non-user owner (a lesson do-it step) takes the lane for that batch, so it waits
//     for the holder to finish. User-direct input (dwell, switch, a11y voice commands) is the
//     user's own and always wins: it does not wait for the holder, only for the batch running
//     right now, and it pauses the holder for a moment so the agent does not fight the user.
// Background tasks never send input; their request_foreground phase acquires the lane.

export const USER_PAUSE_MS = 1500

export interface LaneClock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const realClock: LaneClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal))
      const t = setTimeout(done, ms)
      function done(): void {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      function onAbort(): void {
        clearTimeout(t)
        reject(abortError(signal!))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const e = new Error('cancelled')
  e.name = 'AbortError'
  return e
}

interface Waiter {
  owner: string
  grant: (release: () => void) => void
  fail: (e: Error) => void
}

export interface RunOpts {
  /** The user's own input (dwell, switch, a11y voice commands): never waits for the holder. */
  user?: boolean
  signal?: AbortSignal
}

export class InputLane {
  private holder: { owner: string; token: object } | null = null
  private waiters: Waiter[] = []
  private batch: Promise<void> = Promise.resolve()
  private pausedUntil = 0

  constructor(private readonly clock: LaneClock = realClock) {}

  /** Who holds the lane (null when free). */
  holderName(): string | null {
    return this.holder?.owner ?? null
  }

  /** Owners waiting for the lane, in order. */
  queued(): string[] {
    return this.waiters.map((w) => w.owner)
  }

  /** Takes the lane for `owner` (FIFO). The returned release is idempotent. */
  acquire(owner: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (!this.holder && !this.waiters.length) return Promise.resolve(this.grant(owner))
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        owner,
        grant: (release) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        },
        fail: reject
      }
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((x) => x !== w)
        reject(abortError(signal!))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(w)
    })
  }

  private grant(owner: string): () => void {
    const token = {}
    this.holder = { owner, token }
    return () => {
      if (this.holder?.token !== token) return
      this.holder = null
      const next = this.waiters.shift()
      if (next) next.grant(this.grant(next.owner))
    }
  }

  /** The user did something themselves: the holder waits a moment before its next batch. */
  noteUserInput(): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + USER_PAUSE_MS)
  }

  /** The holder is paused by recent user input. */
  paused(): boolean {
    return this.clock.now() < this.pausedUntil
  }

  /** Runs one input batch; batches never interleave. */
  async run<T>(owner: string, fn: () => Promise<T>, opts: RunOpts = {}): Promise<T> {
    if (opts.user) {
      this.noteUserInput()
      return this.exclusive(fn)
    }
    if (this.holder?.owner === owner) {
      while (this.paused()) await this.clock.sleep(this.pausedUntil - this.clock.now(), opts.signal)
      return this.exclusive(fn)
    }
    const release = await this.acquire(owner, opts.signal)
    try {
      return await this.exclusive(fn)
    } finally {
      release()
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.batch
    let done!: () => void
    this.batch = new Promise<void>((r) => (done = r))
    return prev.then(fn).finally(done)
  }
}

let lane = new InputLane()

export function inputLane(): InputLane {
  return lane
}

/** Test hook. */
export function setInputLane(next: InputLane | null): void {
  lane = next ?? new InputLane()
}

/** One real-input batch through the lane (agent, lesson do-it, dwell, switch, a11y). */
export function withInputLane<T>(owner: string, fn: () => Promise<T>, opts?: RunOpts): Promise<T> {
  return lane.run(owner, fn, opts)
}
