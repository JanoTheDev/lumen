// Intent routing for one utterance, in order:
//   1. 06's local grammar (injected; a no-op until 06 lands). Handled means done.
//   2. The local prefilter: whole-utterance commands only (guide nav while a guide is active,
//      save/replay/play with the word "guide", cancel words, "do it" continuations).
//   3. The LLM router on the fast model: mode, screen needs, target app and parallel split.
//      The main call receives the mode as an instruction and does not re-decide it.
import { z } from 'zod'
import { appUrl } from '../ai/app-context'
import { parseJsonAs } from '../ai/json'
import { ROUTER_PROMPT, routerTurn, type RouterInput } from '../ai/prompts/router'
import { getProvider } from '../ai/providers'
import {
  isReplayRequest,
  matchPlayGuide,
  matchSaveGuide,
  normalizeUtterance,
  parseGuideNav,
  type GuideNavCommand
} from '../guides/voice-nav'
import { log } from '../logger'
import { matchMemoryCommand, type MemoryCommand } from './memory-commands'

// ---- 1. Local grammar hook (06) ----

/** A request the local grammar fully handled; `response` goes back to the renderer. */
export interface Handled {
  response: unknown
}

export type LocalGrammar = (utterance: string) => Handled | null

const noGrammar: LocalGrammar = () => null
let localGrammar: LocalGrammar = noGrammar

/** Installs 06's grammar matcher; null restores the no-op default. */
export function setLocalGrammar(fn: LocalGrammar | null): void {
  localGrammar = fn ?? noGrammar
}

export function runLocalGrammar(utterance: string): Handled | null {
  return localGrammar(utterance)
}

// ---- 2. Local prefilter ----

export type PrefilterHit =
  | { kind: 'cancel' }
  | { kind: 'guide-nav'; command: GuideNavCommand }
  | { kind: 'guide-play'; name: string }
  | { kind: 'guide-replay' }
  | { kind: 'guide-save'; name?: string }
  | { kind: 'continuation' }
  | { kind: 'memory'; command: MemoryCommand }

export interface PrefilterState {
  guideActive: boolean
  /** A guide was shown this session (save / replay target). */
  hasLastGuide: boolean
  /** A previous task exists that "do it" can confirm. */
  hasLastTask: boolean
}

// Matched against the normalized utterance (lowercase, no punctuation or filler words such
// as "ok", "please", "hey lumen").
const CANCEL_RE = /^(cancel|cancel that|stop|stop it|stop that|abort|never ?mind|forget it)$/
const CONTINUATION_RE =
  /^(just )?(do it|do that|go ahead|proceed|yes|yes go ahead|yes do it|sure go ahead|yep do it)$/

const MAX_COMMAND_CHARS = 80

/** Whole-utterance "do it" / "yes go ahead". */
export function isContinuation(utterance: string): boolean {
  return CONTINUATION_RE.test(normalizeUtterance(utterance))
}

/** High-precision local commands only; anything else (or anything long) returns null. */
export function prefilter(utterance: string, state: PrefilterState): PrefilterHit | null {
  const text = normalizeUtterance(utterance)
  if (!text) return null
  // "remember that …" can carry a longer fact; the matcher caps its own length.
  const memory = matchMemoryCommand(utterance)
  if (memory) return { kind: 'memory', command: memory }
  if (utterance.length > MAX_COMMAND_CHARS) return null
  if (CANCEL_RE.test(text)) return { kind: 'cancel' }
  if (state.guideActive) {
    const command = parseGuideNav(utterance)
    if (command) return { kind: 'guide-nav', command }
  }
  const play = matchPlayGuide(utterance)
  if (play) return { kind: 'guide-play', name: play }
  if (state.hasLastGuide) {
    if (isReplayRequest(utterance)) return { kind: 'guide-replay' }
    const save = matchSaveGuide(utterance)
    if (save) return { kind: 'guide-save', ...save }
  }
  if (state.hasLastTask && CONTINUATION_RE.test(text)) return { kind: 'continuation' }
  return null
}

/**
 * Stages 1 and 2 for the query IPC: returns the renderer response when the utterance was
 * handled locally, else undefined (it goes on to the pipeline). Continuations are left to
 * the pipeline, which re-runs the previous task.
 */
export function routeLocal(
  utterance: string,
  state: PrefilterState,
  handle: (hit: Exclude<PrefilterHit, { kind: 'continuation' }>) => unknown | undefined
): unknown | undefined {
  const grammar = runLocalGrammar(utterance)
  if (grammar) {
    log('plan', `local grammar handled "${utterance.slice(0, 40)}"`)
    return grammar.response
  }
  const hit = prefilter(utterance, state)
  if (!hit || hit.kind === 'continuation') return undefined
  const detail =
    hit.kind === 'guide-nav' || hit.kind === 'memory' ? ` ${JSON.stringify(hit.command)}` : ''
  log('plan', `prefilter: ${hit.kind}${detail}`)
  return handle(hit)
}

// ---- 3. LLM router ----

export const ROUTE_MODES = [
  'answer',
  'guide',
  'locate',
  'action',
  'text_insert',
  'plan',
  'research',
  'describe',
  'clarify'
] as const

export type RouteMode = (typeof ROUTE_MODES)[number]

// No numeric bounds or array lengths in the schema: structured outputs reject most of them.
// normalizeRoute enforces them instead.
export const routeSchema = z.object({
  mode: z.enum(ROUTE_MODES),
  needsScreen: z.boolean(),
  needsUia: z.boolean(),
  targetApp: z
    .object({
      name: z.string(),
      url: z.string().optional(),
      process: z.string().optional()
    })
    .optional(),
  appSwitch: z.boolean(),
  parallelSplit: z.array(z.string()).optional(),
  confidence: z.number()
})

export type Route = z.infer<typeof routeSchema>

export const ROUTER_MAX_TOKENS = 200
export const ROUTER_TIMEOUT_MS = 3000
const MAX_SPLIT = 4

// These modes always look at the screen, whatever the router said.
const SCREEN_MODES = new Set<RouteMode>(['guide', 'locate', 'text_insert', 'describe', 'plan'])

/** Clamps confidence, keeps splits to 2–4 answer questions, resolves the app URL. */
export function normalizeRoute(raw: Route): Route {
  const route: Route = {
    ...raw,
    confidence: Math.min(1, Math.max(0, Number.isFinite(raw.confidence) ? raw.confidence : 0)),
    needsScreen: raw.needsScreen || SCREEN_MODES.has(raw.mode)
  }
  const split = raw.parallelSplit?.map((s) => s.trim()).filter(Boolean) ?? []
  if (raw.mode === 'answer' && split.length >= 2 && split.length <= MAX_SPLIT)
    route.parallelSplit = split
  else delete route.parallelSplit
  if (raw.targetApp?.name.trim()) {
    const name = raw.targetApp.name.trim()
    // The table wins; a model URL is only a hint and must be plain https.
    const url =
      appUrl(name) ??
      (raw.targetApp.url && /^https:\/\/[^\s]+$/i.test(raw.targetApp.url)
        ? raw.targetApp.url
        : undefined)
    route.targetApp = { ...raw.targetApp, name, url }
    if (!url) delete route.targetApp.url
  } else {
    delete route.targetApp
  }
  route.appSwitch = raw.appSwitch && !!route.targetApp
  return route
}

/**
 * One fast-model call. Returns null when the router fails, times out or replies with
 * something unusable: the main model then decides the mode itself. Throws only when the
 * caller's signal aborted.
 */
export async function routeWithLlm(
  input: RouterInput,
  signal?: AbortSignal
): Promise<Route | null> {
  const t0 = Date.now()
  const timeout = AbortSignal.timeout(ROUTER_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const { llm, model, effort } = getProvider('fast')
    const res = await llm.complete(
      {
        model,
        system: [{ text: ROUTER_PROMPT, cacheable: true }],
        messages: [{ role: 'user', content: routerTurn(input) }],
        maxTokens: ROUTER_MAX_TOKENS,
        effort,
        schema: routeSchema,
        schemaName: 'lumen_route'
      },
      combined
    )
    const raw = res.data ?? parseJsonAs(res.text, routeSchema)
    const ms = Date.now() - t0
    if (!raw) {
      log('fail', `router reply unusable after ${ms}ms; main model decides`, { model: res.model })
      return null
    }
    const route = normalizeRoute(raw)
    log('time', `router ${ms}ms → ${describeRoute(route)}`, { model: res.model, timeMs: ms })
    return route
  } catch (e) {
    if (signal?.aborted) throw e
    log(
      'fail',
      `router failed after ${Date.now() - t0}ms (${(e as Error).message}); main model decides`
    )
    return null
  }
}

export function describeRoute(r: Route): string {
  const parts = [`${r.mode} ${r.confidence.toFixed(2)}`, r.needsScreen ? 'screen' : 'no-screen']
  if (r.needsUia) parts.push('uia')
  if (r.targetApp) parts.push(`app=${r.targetApp.name}${r.appSwitch ? ' (switch)' : ''}`)
  if (r.parallelSplit) parts.push(`split=${r.parallelSplit.length}`)
  return parts.join(', ')
}

/** Below this the main model picks the mode itself. */
export const MIN_ROUTE_CONFIDENCE = 0.5

/** The routed_mode line for the main call; null when the main model should decide. */
export function mainModeFor(route: Route | null): string | null {
  if (!route || route.confidence < MIN_ROUTE_CONFIDENCE) return null
  if (route.mode === 'describe') return 'answer'
  if (route.mode === 'plan' || route.mode === 'research') return null
  return route.mode
}
