// Bridge check DSL (07 T23–T25): matches a lesson's `expect` against a bridge state.
//   key: value             equal (strings ignore case)
//   key: {gte|gt|lte|lt|eq} number comparison
//   fooChanged / foo_changed: true   `foo` differs from the state seen when the step began
//   hasFoo: "x"            the list `foos` contains "x" (when the state has no `hasFoo`)
//   last_operator: "ID"    that operator ran since the step began (Blender history)
//   request: "…"           which question to ask (OBS); not compared
export type BridgeState = Record<string, unknown>

/** Keys that pick what to ask rather than what to compare. */
export const SELECTOR_KEYS: readonly string[] = ['request']

const eqi = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

type Compare = { gte?: number; gt?: number; lte?: number; lt?: number; eq?: number }
const COMPARE_KEYS = ['gte', 'gt', 'lte', 'lt', 'eq']

function isCompare(v: unknown): v is Compare {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => COMPARE_KEYS.includes(k))
}

export function valueMatches(got: unknown, want: unknown): boolean {
  if (isCompare(want)) {
    if (typeof got !== 'number') return false
    const c = want
    return (
      (c.gte === undefined || got >= c.gte) &&
      (c.gt === undefined || got > c.gt) &&
      (c.lte === undefined || got <= c.lte) &&
      (c.lt === undefined || got < c.lt) &&
      (c.eq === undefined || got === c.eq)
    )
  }
  if (want && typeof want === 'object') return same(got, want)
  return eqi(got, want)
}

/** 'recordDirectoryChanged' → 'recordDirectory'; 'base_color_changed' → 'base_color'. */
export function changedBase(key: string): string | null {
  const m = /^(.+?)(?:Changed|_changed)$/.exec(key)
  return m ? m[1] : null
}

/** 'hasInputKind' → 'inputKinds'. */
export function hasList(key: string): string | null {
  const m = /^has([A-Z])(.*)$/.exec(key)
  return m ? `${m[1].toLowerCase()}${m[2]}s` : null
}

interface OpEntry {
  seq: number
  idname: string
}

function operatorRan(state: BridgeState, want: unknown, base: BridgeState | null): boolean {
  if (!base || typeof want !== 'string') return false
  const since = typeof base.op_seq === 'number' ? base.op_seq : Infinity
  const ops = Array.isArray(state.operators) ? (state.operators as OpEntry[]) : []
  return ops.some((o) => typeof o?.seq === 'number' && o.seq > since && eqi(o.idname, want))
}

function keyMatches(
  state: BridgeState,
  key: string,
  want: unknown,
  base: BridgeState | null
): boolean {
  if (key === 'last_operator') return operatorRan(state, want, base)
  if (key in state) return valueMatches(state[key], want)
  const changed = changedBase(key)
  if (changed && changed in state) {
    if (!base) return false
    return !same(state[changed], base[changed]) === !!want
  }
  const list = hasList(key)
  if (list && Array.isArray(state[list])) {
    const has = (state[list] as unknown[]).some((v) => eqi(v, want))
    return has
  }
  return false
}

/**
 * Whether `state` meets every key of `expect`. `base` is the state from the step's first
 * question (null when there is none yet): "changed" keys and last_operator need it.
 */
export function matchExpect(
  state: BridgeState,
  expect: Record<string, unknown>,
  base: BridgeState | null
): boolean {
  return Object.entries(expect).every(
    ([k, v]) => SELECTOR_KEYS.includes(k) || keyMatches(state, k, v, base)
  )
}
