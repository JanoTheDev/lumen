import { useEffect, useRef, useState } from 'react'

export const DRAFT_DEBOUNCE_MS = 500

export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

export function isHexColor(v: string): boolean {
  return HEX_COLOR_RE.test(v)
}

// Parses free-typed number text and clamps it into range. Returns null when the
// text is not a number, so the caller can revert to the last saved value.
export function parseClamped(text: string, min: number, max: number): number | null {
  const t = text.trim()
  if (!t) return null
  const v = Number(t)
  if (!Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

export interface DraftCommitter<T> {
  get: () => T
  set: (v: T) => void
  flush: () => void
  cancel: () => void
  // Adopt a value saved elsewhere as the new baseline without committing it.
  sync: (v: T) => void
  // Swap the commit/accept callbacks (e.g. after a re-render) without losing the pending draft.
  bind: (commit: (v: T) => void, accept?: (v: T) => boolean) => void
}

export interface DraftOptions<T> {
  delay?: number
  accept?: (v: T) => boolean
}

// Holds a local draft and commits it after `delay` ms of inactivity or on flush().
// Only accepted values that differ from the last committed value are committed.
export function createDraftCommitter<T>(
  initial: T,
  commit: (v: T) => void,
  opts: DraftOptions<T> = {}
): DraftCommitter<T> {
  const delay = opts.delay ?? DRAFT_DEBOUNCE_MS
  let accept = opts.accept ?? ((): boolean => true)
  let draft = initial
  let committed = initial
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const flush = (): void => {
    cancel()
    if (draft === committed || !accept(draft)) return
    committed = draft
    commit(draft)
  }
  return {
    get: () => draft,
    set: (v) => {
      draft = v
      cancel()
      timer = setTimeout(flush, delay)
    },
    flush,
    cancel,
    sync: (v) => {
      committed = v
      if (!timer) draft = v
    },
    bind: (nextCommit, nextAccept) => {
      commit = nextCommit
      accept = nextAccept ?? ((): boolean => true)
    }
  }
}

export interface Draft<T> {
  value: T
  onChange: (v: T) => void
  onBlur: () => void
  flush: () => void
}

// React wrapper: local state for a text field that saves on blur or after a pause,
// and ignores incoming config echoes while the user is typing.
export function useDraft<T>(
  value: T,
  commit: (v: T) => void,
  opts: DraftOptions<T> = {}
): Draft<T> {
  const [draft, setDraft] = useState(value)
  const editingRef = useRef(false)
  const [committer] = useState(() => createDraftCommitter(value, commit, opts))
  const { accept } = opts

  useEffect(() => {
    committer.bind(commit, accept)
  })

  useEffect(() => {
    committer.sync(value)
    if (!editingRef.current) setDraft(value)
  }, [value, committer])

  useEffect(() => () => committer.flush(), [committer])

  return {
    value: draft,
    onChange: (v) => {
      editingRef.current = true
      setDraft(v)
      committer.set(v)
    },
    onBlur: () => {
      committer.flush()
      editingRef.current = false
      const current = committer.get()
      if (accept && !accept(current)) {
        committer.sync(value)
        setDraft(value)
      }
    },
    flush: () => committer.flush()
  }
}
