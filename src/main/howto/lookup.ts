// lookup_howto (05 T36): how to do a goal in an app, cheapest source first:
//   1. learned app notes (what worked here before), 2. the local cache,
//   3. free official docs (Microsoft Learn for Microsoft apps),
//   4. the provider's paid web search, only in 'auto' mode when the user allowed paid search,
//      within PAID_PER_TASK / PAID_PER_DAY.
// Results are short steps with UI names (the grounding targets) and their sources. Web text is
// redacted here; the tool fences it as <observed>. Pure logic: every effect is a dependency.
import { redact } from '../ai/memory/sensitive'
import type { HowtoCache } from './cache'
import type { AppNote, AppNotesStore } from './notes'
import type { PaidAnswer } from './paid'
import { learnHowto, type GetText } from './sources'
import type { AppIdentity, HowtoMode, HowtoResult, HowtoStep } from './types'
import { isMicrosoftApp } from './version'

export interface LookupDeps {
  mode(): HowtoMode
  /** The user turned on paid web search (Settings → News & reading). */
  paidAllowed(): boolean
  /** null while memory is off or in private mode: nothing learned is read or kept. */
  notes(): AppNotesStore | null
  cache: HowtoCache
  get: GetText
  /** The provider's web search on the user's key; null when no provider offers one. */
  paid: ((question: PaidQuestion, signal?: AbortSignal) => Promise<PaidAnswer>) | null
  /** Records usage and the search fee; returns the USD cost of the answer. */
  recordPaid(a: PaidAnswer): number
  log(msg: string): void
}

export interface PaidQuestion {
  app: string
  version: string
  goal: string
  maxSearches: number
}

export interface LookupInput {
  id: AppIdentity
  goal: string
  /** Paid searches are capped per task. */
  taskId: string
}

const cleanStep = (s: HowtoStep): HowtoStep => ({
  text: redact(s.text),
  ui: s.ui.map((u) => redact(u)),
  ...(s.shortcut ? { shortcut: s.shortcut } : {})
})

/** A learned note as steps: the path it took, in order. */
export function noteSteps(n: AppNote): HowtoStep[] {
  const path = n.path.ui.join(' > ')
  const text = path
    ? `Worked here before: ${path}${n.path.shortcut ? ` (or ${n.path.shortcut})` : ''}`
    : `Worked here before: press ${n.path.shortcut}`
  return [{ text, ui: n.path.ui, ...(n.path.shortcut ? { shortcut: n.path.shortcut } : {}) }]
}

export async function lookupHowto(
  input: LookupInput,
  deps: LookupDeps,
  signal?: AbortSignal
): Promise<HowtoResult> {
  const { id, taskId } = input
  const goal = input.goal.replace(/\s+/g, ' ').trim().slice(0, 200)
  const base = { app: id.app, version: id.version, goal, searches: 0, costUsd: 0 }
  const none = (note: string): HowtoResult => ({
    ...base,
    steps: [],
    sources: [],
    from: 'none',
    note
  })
  const mode = deps.mode()
  if (mode === 'off') return none('How-to lookups are off (Settings → Privacy).')
  if (!goal) return none('No goal given.')

  const note = deps.notes()?.find(id, goal)
  if (note) {
    deps.log(`howto: app note for "${goal}" in ${id.appId}`)
    // The note's own goal, so a failure later finds the same note.
    return { ...base, goal: note.goal, steps: noteSteps(note), sources: [], from: 'notes' }
  }
  const cached = deps.cache.get(id, goal)
  if (cached) {
    deps.log(`howto: cache ${cached.from === 'none' ? 'miss' : 'hit'} for "${goal}" in ${id.appId}`)
    return cached
  }

  if (isMicrosoftApp(id.app)) {
    const docs = await learnHowto(id.app, goal, deps.get, signal).catch((e: Error) => {
      if (signal?.aborted) throw e
      deps.log(`howto: Microsoft Learn failed (${e.message})`)
      return null
    })
    if (docs) {
      const r: HowtoResult = {
        ...base,
        steps: docs.steps.map(cleanStep),
        sources: docs.sources,
        from: 'docs'
      }
      deps.cache.put(id, goal, r)
      return r
    }
  }

  if (mode !== 'auto' || !deps.paidAllowed() || !deps.paid)
    return none(
      mode === 'free-only' || !deps.paidAllowed()
        ? 'No free how-to found. Paid web search is off.'
        : 'No free how-to found, and the AI provider has no web search.'
    )
  const left = deps.cache.paidLeft(taskId)
  if (left <= 0) return none('The web search limit for this task or today is reached.')
  let paid: PaidAnswer
  try {
    paid = await deps.paid({ app: id.app, version: id.version, goal, maxSearches: left }, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    deps.log(`howto: web search failed (${(e as Error).message})`)
    return none('The web search failed.')
  }
  deps.cache.notePaid(taskId, paid.searches)
  const costUsd = deps.recordPaid(paid)
  deps.log(
    `howto: web search "${goal}" in ${id.appId}: ${paid.steps.length} steps, ${paid.searches} searches`
  )
  const r: HowtoResult = paid.steps.length
    ? {
        ...base,
        steps: paid.steps.map(cleanStep),
        sources: paid.sources.slice(0, 5),
        from: 'web-search',
        searches: paid.searches,
        costUsd
      }
    : { ...none('The web search found no steps.'), searches: paid.searches, costUsd }
  deps.cache.put(id, goal, r)
  return r
}
