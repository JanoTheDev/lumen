// ask_user (T12): the question is spoken and shown with its choices; the next utterance (a short
// hands-free turn), a typed reply or a choice button answers it. No answer in time → null, and
// the runner pauses the task.

export interface AskIo {
  /** Speaks the question (TTS / screen reader per the user's settings). */
  speak(text: string): void
  /** Opens the microphone for a short hands-free answer. */
  listen(): void
}

export const ASK_TIMEOUT_MS = 30_000

let pending: { resolve: (answer: string) => void } | null = null
const settledListeners = new Set<() => void>()

/**
 * Called once each question is settled (answered, timed out, replaced or cancelled), e.g. so a
 * page reading paused by the question's re-listen goes on. Returns an unsubscribe.
 */
export function onAskSettled(fn: () => void): () => void {
  settledListeners.add(fn)
  return () => settledListeners.delete(fn)
}

/** A question is waiting for the user. */
export function askPending(): boolean {
  return !!pending
}

/** Answers the waiting question (utterance, typed text or choice button); false when none waits. */
export function answerQuestion(answer: string): boolean {
  const p = pending
  const text = answer.trim()
  if (!p || !text) return false
  pending = null
  p.resolve(text)
  return true
}

/** Asks and waits; null on timeout. Throws the abort reason when the task is cancelled. */
export function askUser(
  question: string,
  io: AskIo,
  signal: AbortSignal,
  timeoutMs = ASK_TIMEOUT_MS
): Promise<string | null> {
  if (signal.aborted) return Promise.reject(signal.reason)
  // A newer question replaces an unanswered one.
  pending?.resolve('')
  return new Promise<string | null>((resolve, reject) => {
    const entry = {
      resolve: (answer: string): void => {
        cleanup()
        resolve(answer || null)
      }
    }
    pending = entry
    const timer = setTimeout(() => entry.resolve(''), timeoutMs)
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (pending === entry) pending = null
      for (const fn of [...settledListeners]) fn()
    }
    io.speak(question)
    io.listen()
  })
}
