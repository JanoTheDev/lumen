// How-to lookup runtime (05 T36): the real dependencies of lookup_howto: config, the shared safe
// GET (robots on), the user's provider web search, usage records, app identity from the native
// agent and the app-notes store in ~/.ai-overlay/app-notes/. Other modules call this file;
// the logic lives in lookup.ts / learn.ts / ground.ts.
import { dirname, join } from 'path'
import { recordUsage } from '../ai/cost'
import { appIdOf } from '../ai/memory/profile'
import { usageCost } from '../ai/pricing'
import { getProvider, hasKey } from '../ai/providers'
import { anthropicClient, toUsage as anthropicUsage } from '../ai/providers/anthropic'
import { openaiClient, toUsage as openaiUsage } from '../ai/providers/openai'
import { addDayUsage } from '../ai/usage-log'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { configPath, loadConfig } from '../config'
import { log } from '../logger'
import { safeGet, type RobotsCache } from '../web/net'
import { HowtoCache } from './cache'
import { createLearner, type TaskLearner } from './learn'
import { lookupHowto, type LookupDeps } from './lookup'
import { AppNotesStore } from './notes'
import { anthropicHowto, openaiHowto, PAID_SEARCH_USD, paidQuestion, type PaidAnswer } from './paid'
import { lookupHowtoHandler } from './tool'
import type { AppIdentity, HowtoMode, HowtoResult } from './types'
import { identityOf } from './version'
import type { ToolHandler } from '../agent-mode/runner'

export { LOOKUP_HOWTO_TOOL } from './tool'
export type { AppIdentity, HowtoResult } from './types'

const SEARCH_FALLBACK_MODEL = 'claude-haiku-4-5'
const DOC_MAX_BYTES = 1_500_000
const robotsCache: RobotsCache = new Map()

const home = (): string => dirname(configPath())

let cache: HowtoCache | null = null
let cacheHome = ''
function howtoCache(): HowtoCache {
  if (!cache || cacheHome !== home()) {
    cacheHome = home()
    cache = new HowtoCache(join(cacheHome, 'howto-cache.json'))
  }
  return cache
}

export function howtoMode(): HowtoMode {
  return loadConfig().agent.howtoLookup ?? 'auto'
}

/** App notes, or null while memory is off or in private mode. */
export function appNotes(): AppNotesStore | null {
  const m = loadConfig().memory
  if (!m.enabled || m.privateMode) return null
  return new AppNotesStore(join(home(), 'app-notes'))
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** The paid search of the user's provider (fast role), null when none is available. */
function paidSearch(): LookupDeps['paid'] {
  const fast = getProvider('fast')
  if (fast.provider === 'openai' && hasKey('openai'))
    return (q, signal) =>
      openaiHowto(
        openaiClient(),
        fast.model,
        paidQuestion(q.app, q.version, q.goal, q.maxSearches),
        q.maxSearches,
        openaiUsage,
        signal
      )
  if (!hasKey('anthropic')) return null
  const model = fast.provider === 'anthropic' ? fast.model : SEARCH_FALLBACK_MODEL
  return (q, signal) =>
    anthropicHowto(
      anthropicClient(),
      model,
      paidQuestion(q.app, q.version, q.goal, q.maxSearches),
      q.maxSearches,
      anthropicUsage,
      signal
    )
}

function recordPaid(a: PaidAnswer): number {
  let usd = a.searches * PAID_SEARCH_USD
  if (a.usage) {
    recordUsage(a.model, a.usage)
    usd += usageCost(a.model, a.usage).total
  }
  if (a.searches) addDayUsage(a.searches * PAID_SEARCH_USD, ZERO, true)
  return usd
}

function deps(): LookupDeps {
  return {
    mode: howtoMode,
    paidAllowed: () => loadConfig().web.paidSearch,
    notes: appNotes,
    cache: howtoCache(),
    get: async (url, accept, signal) => {
      const r = await safeGet(url, {
        signal,
        robots: true,
        robotsCache,
        maxBytes: DOC_MAX_BYTES,
        overflow: 'cut',
        accept
      })
      return { url: r.url, status: r.status, body: r.body }
    },
    paid: paidSearch(),
    recordPaid,
    log: (msg) => log('plan', msg)
  }
}

/** The app in front, from the native agent (null without an agent). */
export async function foregroundIdentity(signal?: AbortSignal): Promise<AppIdentity | null> {
  const agent = getAgent()
  if (!agent) return null
  const w = await commands.activeWindow(agent, { signal, timeoutMs: 1500 }).catch(() => null)
  return w ? identityOf(w) : null
}

/** A named app (version only when it is the one in front). */
async function identify(app: string | undefined, signal?: AbortSignal): Promise<AppIdentity> {
  const fg = await foregroundIdentity(signal)
  if (!app) return fg ?? { app: 'this app', appId: 'unknown', version: '' }
  if (fg && (fg.appId === appIdOf(app) || fg.app.toLowerCase().includes(app.toLowerCase())))
    return fg
  return { app, appId: appIdOf(app), version: '' }
}

export function lookup(
  id: AppIdentity,
  goal: string,
  taskId: string,
  signal?: AbortSignal
): Promise<HowtoResult> {
  return lookupHowto({ id, goal, taskId }, deps(), signal)
}

let turnSeq = 0

/** How to do `goal` in the app in front (show me how, locate fallback); caps count per turn. */
export async function howtoForeground(goal: string, signal?: AbortSignal): Promise<HowtoResult> {
  const id = await identify(undefined, signal)
  return lookup(id, goal, `turn-${++turnSeq}`, signal)
}

/** The app-notes learner of one agent task. */
export function taskLearner(): TaskLearner {
  return createLearner({
    notes: appNotes,
    identify: () => foregroundIdentity(),
    log: (msg) => log('plan', msg)
  })
}

/**
 * lookup_howto for an agent run; `learner` watches notes it returns. `budgetId`: the task whose
 * paid-search cap applies (a spawn_task helper spends its parent's, not a fresh one).
 */
export function howtoToolHandler(learner?: TaskLearner, budgetId?: string): ToolHandler {
  return lookupHowtoHandler({
    identify: (app, signal) => identify(app, signal),
    lookup: (id, goal, taskId, signal) => lookup(id, goal, taskId, signal),
    onResult: (id, r) => learner?.looked(id, r),
    ...(budgetId ? { budgetId } : {})
  })
}
