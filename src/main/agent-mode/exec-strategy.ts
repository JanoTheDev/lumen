// Ghost cursor strategy (T10, agent-loop.md): how one `act` call runs.
// 1. The target is a UIA element with the matching pattern: invoke / toggle / select / expand /
//    focus / set_value through uia_act. The real pointer stays where the user left it; the
//    buddy flies to the element so the user sees what happened.
// 2. Otherwise real input: the buddy flies first, then the pointer moves and clicks (dwell is
//    held by the executor for the batch), and the pointer goes back to where it was when the
//    user has not touched it meanwhile.
// Text: set_value when the field has ValuePattern and is not rich text, else focus + type.
// Retries never type blindly: a field the agent already typed into is read first.
import type { Action, ElementNode, Point, Rect, Target } from '@shared/types'
import type { ExecuteResult } from '../actions/executor'
import type { ActInput } from './tools'

export interface StrategyPorts {
  /** An element of the latest snapshot (physical rects). */
  element(id: string): ElementNode | undefined
  /** The field's current value: the element's UIA value, else the focused field's; null = unknown. */
  readValue(el: ElementNode | undefined, signal: AbortSignal): Promise<string | null>
  /** executeActions with the task's policy context (origin agent, task state, no preview). */
  execute(actions: Action[], signal: AbortSignal): Promise<ExecuteResult>
  /** Buddy on the screen layer, logical px; null hides it. */
  buddy(to: Point | null, mode: 'fly' | 'point'): void
  physToLogical(p: Point): Point
  /** Real pointer, physical px; null when unknown. */
  pointer(): Point | null
  /** Moves the real pointer back (an `input` move through the executor). */
  restorePointer(p: Point, signal: AbortSignal): Promise<void>
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** Fields the agent typed into this task: field key → text. */
export interface TypedFields {
  typed: Map<string, string>
}

export interface ActResult {
  ok: boolean
  message: string
  /** Real actions sent (counted against the action cap). */
  actions: number
  /** Ran through UIA patterns only (the pointer did not move). */
  ghost: boolean
  /** Physical rect acted on (verification crops around it). */
  rect?: Rect
  /** Executor result of the main action. */
  exec?: ExecuteResult
}

/** Buddy lead before real input moves the pointer (kept ≤ 150 ms: no long fixed waits). */
export const BUDDY_LEAD_MS = 150

const UIA_OPS = new Set(['invoke', 'toggle', 'select', 'expand', 'focus'])
const PATTERN_FOR: Record<string, string> = {
  invoke: 'invoke',
  toggle: 'toggle',
  select: 'select',
  expand: 'expand',
  set_value: 'value'
}

const center = (r: Rect): Point => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) })

/** Rich text (documents, contenteditable): ValuePattern replaces formatting or is read-only. */
export function isRichText(el: ElementNode): boolean {
  return /^(document|pane|custom)$/i.test(el.role)
}

function targetOf(t: NonNullable<ActInput['target']>): Target | string {
  switch (t.kind) {
    case 'element':
      return { kind: 'element', id: t.ref }
    case 'mark': {
      const n = Number(t.ref)
      return Number.isInteger(n) && n > 0 ? { kind: 'mark', n } : `mark "${t.ref}" is not a number`
    }
    case 'text':
      return { kind: 'text', text: t.ref, ...(t.nth && t.nth > 1 ? { nth: t.nth - 1 } : {}) }
    case 'point': {
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(t.ref)
      return m
        ? { kind: 'point', x: Number(m[1]), y: Number(m[2]), frame: '1' }
        : `point "${t.ref}" is not "x,y"`
    }
  }
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

function fieldKey(input: ActInput, el: ElementNode | undefined): string {
  if (el) return `${el.role}|${el.name}|${el.automationId ?? ''}`
  return input.target ? `${input.target.kind}:${input.target.ref}` : 'focused'
}

function result(exec: ExecuteResult, what: string, ghost: boolean, rect?: Rect): ActResult {
  if (exec.cancelled)
    return { ok: false, message: 'Cancelled.', actions: exec.executed, ghost, exec }
  if (exec.denied)
    return {
      ok: false,
      message: `E_DENIED: ${exec.denied.reason}. The safety policy or the user stopped this; do not retry it.`,
      actions: exec.executed,
      ghost,
      exec
    }
  if (!exec.executed)
    return {
      ok: false,
      message: `${what}: the target was not found on screen. Observe again and pick another target.`,
      actions: 0,
      ghost,
      exec
    }
  return { ok: true, message: `${what}: done.`, actions: exec.executed, ghost, rect, exec }
}

export async function performAct(
  input: ActInput,
  ports: StrategyPorts,
  fields: TypedFields,
  signal: AbortSignal
): Promise<ActResult> {
  const t = input.target ? targetOf(input.target) : null
  if (typeof t === 'string') return { ok: false, message: t, actions: 0, ghost: false }
  const el = t?.kind === 'element' ? ports.element(t.id) : undefined
  if (t?.kind === 'element' && !el)
    return {
      ok: false,
      message: `Element ${t.id} is not in the latest snapshot. Call observe and use a current id.`,
      actions: 0,
      ghost: false
    }
  const rect = el?.rect
  const what = `${input.op}${el ? ` "${el.name}"` : input.target ? ` "${input.target.ref}"` : ''}`

  const ghost = async (action: Action): Promise<ActResult> => {
    if (rect) ports.buddy(ports.physToLogical(center(rect)), 'point')
    return result(await ports.execute([action], signal), what, true, rect)
  }

  const real = async (actions: Action[]): Promise<ActResult> => {
    if (rect) {
      ports.buddy(ports.physToLogical(center(rect)), 'fly')
      await ports.sleep(BUDDY_LEAD_MS, signal)
    }
    const before = ports.pointer()
    const exec = await ports.execute(actions, signal)
    const r = result(exec, what, false, rect ?? exec.targets[0])
    // Back to where the user had it, unless they moved it while Lumen clicked.
    const clicked = exec.targets.length ? center(exec.targets[exec.targets.length - 1]) : null
    const now = ports.pointer()
    if (before && clicked && now && Math.hypot(now.x - clicked.x, now.y - clicked.y) <= 3)
      await ports.restorePointer(before, signal).catch(() => {})
    return r
  }

  const click = (button: 'left' | 'right' = 'left'): Promise<ActResult> => {
    if (!t)
      return Promise.resolve({
        ok: false,
        message: `${input.op} needs a target.`,
        actions: 0,
        ghost: false
      })
    return real([
      { type: 'click_target', target: t, button, ...(el ? { description: el.name } : {}) }
    ])
  }

  switch (input.op) {
    case 'click':
      return click('left')
    case 'right_click':
      return click('right')
    case 'double_click': {
      if (!rect)
        return {
          ok: false,
          message: 'double_click needs an element id (observe first).',
          actions: 0,
          ghost: false
        }
      const c = center(rect)
      return real([
        { type: 'input', steps: [{ t: 'click', button: 'left', x: c.x, y: c.y, count: 2 }] }
      ])
    }
    case 'invoke':
    case 'toggle':
    case 'select':
    case 'expand':
    case 'focus': {
      if (
        el &&
        UIA_OPS.has(input.op) &&
        (input.op === 'focus' || el.patterns.includes(PATTERN_FOR[input.op] as never))
      )
        return ghost({ type: 'uia_act', elementId: el.id, action: input.op, description: el.name })
      return click('left')
    }
    case 'set_value':
    case 'type':
      return typeText(input, el, t, ports, fields, signal, what, ghost, real)
    case 'scroll': {
      const dy = input.dy ?? 0
      const dx = input.dx ?? 0
      if (!dx && !dy)
        return { ok: false, message: 'scroll needs dx or dy.', actions: 0, ghost: false }
      const vertical = Math.abs(dy) >= Math.abs(dx)
      const amount = Math.abs(vertical ? dy : dx)
      const direction = vertical ? (dy > 0 ? 'down' : 'up') : dx > 0 ? 'right' : 'left'
      const at = t?.kind === 'point' ? { x: t.x, y: t.y } : {}
      return result(
        await ports.execute([{ type: 'scroll', direction, amount, ...at }], signal),
        what,
        false
      )
    }
  }
}

async function typeText(
  input: ActInput,
  el: ElementNode | undefined,
  t: Target | null,
  ports: StrategyPorts,
  fields: TypedFields,
  signal: AbortSignal,
  what: string,
  ghost: (a: Action) => Promise<ActResult>,
  real: (a: Action[]) => Promise<ActResult>
): Promise<ActResult> {
  const text = input.value ?? ''
  if (!text) return { ok: false, message: `${input.op} needs a value.`, actions: 0, ghost: false }
  const key = fieldKey(input, el)
  const earlier = fields.typed.get(key)
  let selectAll = false
  // Retry guard: read the field before typing into it again.
  if (earlier !== undefined) {
    const value = await ports.readValue(el, signal)
    if (value === null)
      return {
        ok: false,
        message:
          'You already typed into this field in this task and its value cannot be read. Observe and check it before typing again.',
        actions: 0,
        ghost: false
      }
    if (norm(value).includes(norm(text)))
      return {
        ok: true,
        message: `The field already contains the text; not typed again.`,
        actions: 0,
        ghost: false
      }
    selectAll = norm(value).length > 0
  }

  let res: ActResult
  const replace = input.op === 'set_value' || selectAll
  if (replace && el && el.patterns.includes('value') && !isRichText(el)) {
    // ValuePattern replaces the whole value without the pointer or the clipboard.
    res = await ghost({
      type: 'uia_act',
      elementId: el.id,
      action: 'set_value',
      value: text,
      description: el.name
    })
  } else {
    const keys: Action[] = [
      ...(replace ? [{ type: 'hotkey' as const, keys: ['ctrl', 'a'] }] : []),
      { type: 'type', text }
    ]
    if (el) {
      const focused = await ghost({
        type: 'uia_act',
        elementId: el.id,
        action: 'focus',
        description: el.name
      })
      res = focused.ok ? merge(focused, await ports.execute(keys, signal)) : focused
    } else {
      res = await real([...(t ? [{ type: 'click_target' as const, target: t }] : []), ...keys])
    }
  }
  if (res.ok) fields.typed.set(key, text)
  return { ...res, message: res.ok ? `${what}: typed.` : res.message }

  function merge(first: ActResult, exec: ExecuteResult): ActResult {
    const r = result(exec, what, true, first.rect)
    return { ...r, actions: first.actions + r.actions }
  }
}
