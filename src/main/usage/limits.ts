// Monthly usage limits (05 T45): optional caps overall (`usage.limits` in config), per
// automation (`usage.limits.automations[id]`) and per buddy (its budget perMonthUsd /
// perMonthTokens), checked against this month's usage ledger. At 80% one Tasks notice per scope
// and month; at 100% one "paused: monthly limit" notice and new automation / buddy runs of that
// scope are refused (the overall cap pauses all of them). Questions the user asks are never
// blocked: past the overall cap they get one warning a month. Notice state lives in
// ~/.ai-overlay/usage/limits-state.json and starts over each month. Tokens = input + output.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UsageLimitsConfig } from '@shared/config'
import { loadConfig } from '../config'
import {
  isExternal,
  ledgerDir,
  ledgerPersisting,
  monthKey,
  monthTotals,
  onUsageRecorded,
  type UsageFilter,
  type UsageRow
} from './ledger'

export type LimitScope =
  | { kind: 'overall' }
  | { kind: 'automation'; id: string }
  | { kind: 'buddy'; id: string }

export interface LimitCap {
  usd?: number
  tokens?: number
}

export type LimitLevel = 'none' | 'ok' | 'warn' | 'paused'

export interface LimitState {
  scope: LimitScope
  /** This month's Lumen spend in the scope. */
  usd: number
  tokens: number
  cap: LimitCap
  /** Highest of usd / cap.usd and tokens / cap.tokens; 0 without a cap. */
  ratio: number
  level: LimitLevel
}

export type RunLimitCheck = { ok: true } | { ok: false; reason: string; scope: LimitScope }

export interface LimitPorts {
  limits(): UsageLimitsConfig | undefined
  /** A buddy's monthly caps and name (null = no such buddy). */
  buddy(id: string): { name: string; perMonthUsd?: number; perMonthTokens?: number } | null
  automationName(id: string): string | undefined
  /** A line in the Tasks list. */
  notify(text: string, scope: LimitScope): void
  /** Bar / spoken warning to the user (overall cap passed while they ask something). */
  warn(text: string): void
  now(): Date
}

const WARN_AT = 0.8
const STATE_FILE = 'limits-state.json'
/** Origins that are the user's own questions: never blocked, only warned. */
const USER_ORIGINS = new Set(['user-direct', 'agent', 'dictation', 'lesson'])

const ports: LimitPorts = {
  limits: () => {
    try {
      return loadConfig().usage?.limits
    } catch {
      return undefined
    }
  },
  buddy: () => null,
  automationName: () => undefined,
  notify: () => {},
  warn: () => {},
  now: () => new Date()
}

/** Wires names, notices and the clock (index / ipc wiring; tests). */
export function setLimitPorts(more: Partial<LimitPorts>): void {
  Object.assign(ports, more)
}

interface SavedState {
  month: string
  warned: string[]
  paused: string[]
  userWarned: boolean
}

let state: SavedState | null = null
let statePathOverride: string | null = null

/** Test hook: where the notice state is kept (null = the ledger folder when it persists). */
export function setLimitsStatePath(path: string | null): void {
  statePathOverride = path
  state = null
  running.clear()
}

function statePath(): string | null {
  if (statePathOverride) return statePathOverride
  return ledgerPersisting() ? join(ledgerDir(), STATE_FILE) : null
}

function freshState(month: string): SavedState {
  return { month, warned: [], paused: [], userWarned: false }
}

function readState(month: string): SavedState {
  if (state?.month === month) return state
  let loaded: SavedState | null = null
  const path = statePath()
  if (!state && path && existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SavedState>
      if (raw.month === month)
        loaded = {
          month,
          warned: Array.isArray(raw.warned) ? raw.warned.filter((x) => typeof x === 'string') : [],
          paused: Array.isArray(raw.paused) ? raw.paused.filter((x) => typeof x === 'string') : [],
          userWarned: raw.userWarned === true
        }
    } catch (e) {
      console.warn(`[usage] limits state unreadable: ${(e as Error).message}`)
    }
  }
  state = loaded ?? freshState(month)
  return state
}

function saveState(s: SavedState): void {
  const path = statePath()
  if (!path) return
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(s), 'utf8')
  } catch (e) {
    console.warn(`[usage] limits state not saved: ${(e as Error).message}`)
  }
}

export const scopeKey = (s: LimitScope): string =>
  s.kind === 'overall' ? 'all' : `${s.kind}:${s.id}`

const positive = (n: number | undefined): number | undefined =>
  typeof n === 'number' && n > 0 ? n : undefined

/** The scope's caps now (config / buddy budget); empty = no cap. */
export function capFor(scope: LimitScope): LimitCap {
  const cfg = ports.limits()
  let usd: number | undefined
  let tokens: number | undefined
  if (scope.kind === 'overall') {
    usd = cfg?.monthlyUsd
    tokens = cfg?.monthlyTokens
  } else if (scope.kind === 'automation') {
    const c = cfg?.automations?.[scope.id]
    usd = c?.usd
    tokens = c?.tokens
  } else {
    const b = ports.buddy(scope.id)
    usd = b?.perMonthUsd
    tokens = b?.perMonthTokens
  }
  const cap: LimitCap = {}
  if (positive(usd) !== undefined) cap.usd = usd
  if (positive(tokens) !== undefined) cap.tokens = tokens
  return cap
}

const hasCap = (c: LimitCap): boolean => c.usd !== undefined || c.tokens !== undefined

function filterFor(scope: LimitScope): UsageFilter {
  if (scope.kind === 'automation') return { automationId: scope.id }
  if (scope.kind === 'buddy') return { buddyId: scope.id }
  return {}
}

let unsubscribe: (() => void) | null = null

// Running month totals per scope key, so a recorded line does not re-read the whole month.
const running = new Map<string, { month: string; usd: number; tokens: number }>()

function spent(scope: LimitScope, now: Date): { usd: number; tokens: number } {
  const month = monthKey(now)
  const key = scopeKey(scope)
  const hit = running.get(key)
  if (hit?.month === month) return hit
  const t = monthTotals(filterFor(scope), now)
  const fresh = { month, usd: t.usd, tokens: t.in + t.out }
  // Cached only while the listener keeps it current.
  if (unsubscribe) running.set(key, fresh)
  return fresh
}

export function ratioOf(sp: { usd: number; tokens: number }, cap: LimitCap): number {
  let r = 0
  if (cap.usd !== undefined && cap.usd > 0) r = Math.max(r, sp.usd / cap.usd)
  if (cap.tokens !== undefined && cap.tokens > 0) r = Math.max(r, sp.tokens / cap.tokens)
  return r
}

const levelOf = (ratio: number, capped: boolean): LimitLevel =>
  !capped ? 'none' : ratio >= 1 ? 'paused' : ratio >= WARN_AT ? 'warn' : 'ok'

/** Spend, cap and level of one scope this month. */
export function limitState(scope: LimitScope): LimitState {
  const now = ports.now()
  const cap = capFor(scope)
  const sp = spent(scope, now)
  const ratio = hasCap(cap) ? ratioOf(sp, cap) : 0
  return { scope, usd: sp.usd, tokens: sp.tokens, cap, ratio, level: levelOf(ratio, hasCap(cap)) }
}

export function money(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}

export function tokenWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} million tokens`
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`
  return `${n} tokens`
}

/** "$8.00 of $10.00" or "80k tokens of 100k tokens" (whichever is closer to its cap). */
function capText(st: LimitState): string {
  const { cap } = st
  const usdR = cap.usd ? st.usd / cap.usd : -1
  const tokR = cap.tokens ? st.tokens / cap.tokens : -1
  return usdR >= tokR && cap.usd !== undefined
    ? `${money(st.usd)} of ${money(cap.usd)}`
    : `${tokenWords(st.tokens)} of ${tokenWords(cap.tokens ?? 0)}`
}

function scopeName(scope: LimitScope): string {
  if (scope.kind === 'automation') {
    const n = ports.automationName(scope.id)
    return n ? `The automation “${n}”` : 'An automation'
  }
  if (scope.kind === 'buddy') {
    const n = ports.buddy(scope.id)?.name
    return n ? `${n}` : 'A buddy'
  }
  return 'Lumen'
}

export function warnText(st: LimitState): string {
  return st.scope.kind === 'overall'
    ? `Lumen has used ${Math.floor(st.ratio * 100)}% of your monthly limit (${capText(st)}).`
    : `${scopeName(st.scope)} has used ${Math.floor(st.ratio * 100)}% of its monthly limit (${capText(st)}).`
}

export function pausedText(st: LimitState): string {
  return st.scope.kind === 'overall'
    ? `Paused: monthly limit reached (${capText(st)}). Automations and buddies wait until next month or until you raise the limit in Settings → Usage.`
    : `${scopeName(st.scope)} is paused: monthly limit reached (${capText(st)}).`
}

/** Whether a new run in this scope may start. */
function refusal(scope: LimitScope): RunLimitCheck {
  const st = limitState(scope)
  if (st.level !== 'paused') return { ok: true }
  const reason =
    scope.kind === 'overall'
      ? `Paused: monthly limit reached (${capText(st)}).`
      : `${scopeName(scope)} is paused: monthly limit reached (${capText(st)}).`
  return { ok: false, reason, scope }
}

/**
 * May a new automation / buddy run start? The overall cap pauses every such run; the
 * automation's or buddy's own cap pauses only its runs. Without ids only the overall cap counts.
 */
export function canStartRun(ids: { automationId?: string; buddyId?: string } = {}): RunLimitCheck {
  const overall = refusal({ kind: 'overall' })
  if (!overall.ok) return overall
  if (ids.automationId) {
    const a = refusal({ kind: 'automation', id: ids.automationId })
    if (!a.ok) return a
  }
  if (ids.buddyId) {
    const b = refusal({ kind: 'buddy', id: ids.buddyId })
    if (!b.ok) return b
  }
  return { ok: true }
}

/** The background start's check: only new automation and buddy runs, never their helpers. */
export function checkRunLimit(input: {
  origin: string
  routineId?: string
  buddyId?: string
  parentId?: string
  run?: unknown
}): RunLimitCheck {
  if (input.parentId || input.run) return { ok: true }
  if (input.origin !== 'routine' && input.origin !== 'buddy') return { ok: true }
  return canStartRun({ automationId: input.routineId, buddyId: input.buddyId })
}

function bump(key: string, month: string, row: UsageRow): void {
  const hit = running.get(key)
  if (hit?.month !== month) return // read fresh (row included) on first use
  hit.usd = Math.round((hit.usd + row.usd) * 1e9) / 1e9
  hit.tokens += row.in + row.out
}

/** Takes a scope out of paused; the overall cap's one also re-arms the user's warning. */
function unpause(key: string, s: SavedState): void {
  if (!s.paused.includes(key)) return
  s.paused = s.paused.filter((k) => k !== key)
  if (key === 'all') s.userWarned = false
}

function check(scope: LimitScope, s: SavedState): boolean {
  const st = limitState(scope)
  const key = scopeKey(scope)
  if (st.level === 'none' || st.level === 'ok') {
    // A raised cap: the next crossing gets its notice again.
    const before = s.warned.length + s.paused.length
    unpause(key, s)
    s.warned = s.warned.filter((k) => k !== key)
    return s.warned.length + s.paused.length !== before
  }
  if (st.level === 'paused') {
    if (!s.paused.includes(key)) {
      s.paused.push(key)
      if (!s.warned.includes(key)) s.warned.push(key)
      ports.notify(pausedText(st), scope)
      return true
    }
    return false
  }
  let changed = false
  if (s.paused.includes(key)) {
    unpause(key, s)
    changed = true
  }
  if (!s.warned.includes(key)) {
    s.warned.push(key)
    ports.notify(warnText(st), scope)
    return true
  }
  return changed
}

/** One recorded ledger line: update the running totals, then the notices. Never throws. */
export function onRow(row: UsageRow): void {
  if (isExternal(row)) return
  const now = ports.now()
  const month = monthKey(now)
  if (monthKey(row.t) !== month) return
  const scopes: LimitScope[] = [{ kind: 'overall' }]
  if (row.automationId) scopes.push({ kind: 'automation', id: row.automationId })
  if (row.buddyId) scopes.push({ kind: 'buddy', id: row.buddyId })
  for (const sc of scopes) bump(scopeKey(sc), month, row)
  const s = readState(month)
  let changed = false
  for (const sc of scopes) if (check(sc, s)) changed = true
  if (USER_ORIGINS.has(row.origin) && !s.userWarned && s.paused.includes('all')) {
    s.userWarned = true
    changed = true
    ports.warn(
      `You're past your monthly usage limit (${capText(limitState({ kind: 'overall' }))}). I'll keep answering you; automations and buddies are paused.`
    )
  }
  if (changed) saveState(s)
}

/** Starts watching the ledger (app start). */
export function installUsageLimits(more: Partial<LimitPorts> = {}): void {
  setLimitPorts(more)
  if (unsubscribe) return
  unsubscribe = onUsageRecorded((row) => {
    try {
      onRow(row)
    } catch (e) {
      console.warn(`[usage] limits check failed: ${(e as Error).message}`)
    }
  })
}

/** Test hook: stop watching and forget cached totals and state. */
export function resetUsageLimits(): void {
  unsubscribe?.()
  unsubscribe = null
  state = null
  running.clear()
}
