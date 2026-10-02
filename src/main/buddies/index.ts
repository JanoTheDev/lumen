// Buddies (08 T50, plans/08-agents-connectors/buddies.md): named helpers with a job, each run a
// background task with origin `buddy`.
//
// Files: ~/.ai-overlay/buddies/<id>/buddy.md (header + instructions), memory.md (notebook,
// ≤ 8 KB, never written with memory off or in private mode), `.lumen-pack.json` marks an
// imported buddy (always community-untrusted). Every load is clamped (clamp.ts).
//
// Public API (for T51 creation, T52 calling / schedules, T53 UI):
//   installBuddies(root?: string): void              start: store + background hook
//   buddies(): Buddies | null                         the service (null before install)
//   listBuddies(): Buddy[]
//   buddySummaries(): BuddySummary[]                  list rows (running, last run)
//   getBuddy(id: string): Buddy | null
//   findBuddy(name: string): Buddy | null             "inbox buddy" → Inbox Buddy
//   createBuddy(fields: Partial<Omit<Buddy,'id'>> & {name: string}): Buddy   trust mine
//   updateBuddy(id, patch: Partial<Omit<Buddy,'id'|'trust'|'createdAt'>>): Buddy | null
//   setBuddyEnabled(id, enabled: boolean): Buddy | null
//   removeBuddy(id): boolean
//   buddyNotebook(id): string
//   setBuddyNotebook(id, text): 'ok'|'disabled'|'rejected'|'too-long'|'missing'
//   runBuddy(id, {utterance?, trigger: 'call'|'schedule'|'manual'}): RunBuddyResult
//       → {ok: true, task} | {ok: false, code: 'E_NOT_FOUND'|'E_OFF'|'E_BUDGET'|'E_BUSY', error}
//   buddyRuns(id, limit = 20): BuddyRunSummary[]     newest first, from the task store
//   setBuddySpendReader(fn: BuddySpendReader | null)  monthly spend (default: usage ledger)
// Events: bus `buddies.changed {ids}` after create / update / remove / run / notebook writes.
// Pure helpers: clamp.ts (clampBuddy, clampPermissions, buddyIdFor, isBuddyId,
// BUDDY_TOOL_NAMES), run.ts (buddyStartInput, buddyManifest, buddyConfirmsEveryAction),
// store.ts (BuddyStore, buddyFileText, parseBuddyFile, IMPORT_MARKER).
//
// A run: userText (the gate's user words) = instructions + what the user said (an imported
// buddy: only what the user said, no "always" grants); the buddy's
// permissions become a skill envelope (tools, connectors, network, read folders; an imported or
// risky buddy confirms every connector / on-screen action, file changes ask in the Tasks list);
// its model role, per-run cost cap, use_skill limited to its skills, run_subagents only with
// `subagents`; memory_write goes to its notebook, which the first turn gets as observed data;
// the run sits in withUsageScope({origin:'buddy', buddyId, taskId}); audit lines carry buddyId.
// Not yet: request_foreground (T52 runs a foreground task under the buddy's envelope).
import { dirname, join } from 'path'
import type { Buddy, BuddyRunSummary, BuddySummary } from '@shared/buddies'
import { isSensitive } from '../ai/memory'
import { memory } from '../ai/memory/runtime'
import { backgroundManager, startBackgroundTask } from '../agent-mode/background'
import { setUngrantedBuddies } from '../actions/policy'
import { setBuddyRunHook } from '../agent-mode/background/buddy-hook'
import { skillEnvelope } from '../agent-mode/skill-envelope'
import { bus } from '../bus'
import { configPath } from '../config'
import { monthTotals } from '../usage/ledger'
import { canStartRun } from '../usage/limits'
import { Buddies, type BuddySpendReader, type RunBuddyResult } from './service'
import type { RunBuddyOpts } from './run'
import { BuddyStore, type NotebookWrite } from './store'

export type { BuddySpendReader, RunBuddyResult } from './service'
export type { RunBuddyOpts } from './run'
export { Buddies } from './service'

let service: Buddies | null = null

/** This month's Lumen spend of the buddy from the usage ledger (tokens = in + out). */
export const ledgerSpend: BuddySpendReader = (buddyId, now) => {
  const t = monthTotals({ buddyId }, now)
  return { usd: t.usd, tokens: t.in + t.out }
}

let spend: BuddySpendReader | null = ledgerSpend

/** The monthly spend reader (default: the usage ledger); null = no monthly check. */
export function setBuddySpendReader(fn: BuddySpendReader | null): void {
  spend = fn
}

export function installBuddies(root = join(dirname(configPath()), 'buddies')): void {
  if (service) return
  const store = new BuddyStore(root, {
    canWrite: () => {
      try {
        return memory().canWrite()
      } catch {
        return false
      }
    },
    sensitive: (t) => isSensitive(t)
  })
  service = new Buddies({
    store,
    start: (input) => startBackgroundTask(input),
    tasks: () => backgroundManager().list(),
    emit: (ids) => bus.emit({ type: 'buddies.changed', ids }),
    envelope: skillEnvelope,
    spend: () => spend
  })
  setBuddyRunHook(service.hook())
  // An imported buddy never uses or offers "always" grants (a deleted one neither).
  setUngrantedBuddies((id) => service?.get(id)?.trust !== 'mine')
}

export function buddies(): Buddies | null {
  return service
}

const NOT_LOADED: RunBuddyResult = {
  ok: false,
  code: 'E_NOT_FOUND',
  error: 'Buddies are not loaded.'
}

export const listBuddies = (): Buddy[] => service?.list() ?? []
export const buddySummaries = (): BuddySummary[] => service?.summaries() ?? []
export const getBuddy = (id: string): Buddy | null => service?.get(id) ?? null
export const findBuddy = (name: string): Buddy | null => service?.byName(name) ?? null

export function createBuddy(fields: Partial<Omit<Buddy, 'id'>> & { name: string }): Buddy {
  if (!service) throw new Error('Buddies are not loaded.')
  return service.create(fields)
}

export const updateBuddy = (
  id: string,
  patch: Partial<Omit<Buddy, 'id' | 'trust' | 'createdAt'>>
): Buddy | null => service?.update(id, patch) ?? null
export const setBuddyEnabled = (id: string, enabled: boolean): Buddy | null =>
  service?.setEnabled(id, enabled) ?? null
export const removeBuddy = (id: string): boolean => service?.remove(id) ?? false
export const buddyNotebook = (id: string): string => service?.notebook(id) ?? ''
export const setBuddyNotebook = (id: string, text: string): NotebookWrite =>
  service?.setNotebook(id, text) ?? 'missing'
export function runBuddy(id: string, opts: RunBuddyOpts): RunBuddyResult {
  if (!service) return NOT_LOADED
  // Monthly usage limits (05 T45): the overall cap pauses every buddy.
  const limit = canStartRun({ buddyId: id })
  if (!limit.ok && service.get(id)) return { ok: false, code: 'E_BUDGET', error: limit.reason }
  return service.run(id, opts)
}
export const buddyRuns = (id: string, limit = 20): BuddyRunSummary[] =>
  service?.runs(id, limit) ?? []
