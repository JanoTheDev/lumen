// Undo records (11 T16), pure: for each action Lumen is about to run, how to reverse it, or an
// honest reason why it cannot be reversed. The executor records before an action runs and
// commits once it ran; "undo that" replays the reversals newest first.
import type { Action, InputStep, ScrollDirection, UiaAction } from '@shared/types'

/** How one action is reversed. */
export type Reversal =
  /** Press a combo (Ctrl+Z, Alt+Left, Ctrl+W) `count` times in the same window. */
  | { kind: 'keys'; combo: string; count: number }
  /** Put a field's old value back (UIA ValuePattern). */
  | { kind: 'set-value'; elementId: string; value: string }
  /** Toggle back, or expand ↔ collapse. */
  | { kind: 'uia'; elementId: string; action: UiaAction }
  | { kind: 'scroll'; direction: ScrollDirection; amount: number }
  /** Copy a file back from Lumen's undo trash (or delete a file Lumen created). */
  | { kind: 'restore-file'; path: string; backup: string | null }
  /** Nothing to do: the action changed nothing (a mouse move, focusing a window). */
  | { kind: 'noop' }

export interface UndoRecord {
  id: string
  at: number
  taskId: string
  /** "typed 12 characters", "pressed Ctrl+V", "opened example.com". */
  what: string
  /** The window it happened in (process name, lower case) — keys only undo there. */
  process?: string
  title?: string
  reversal: Reversal | null
  /** Why it cannot be undone, in plain words ("an email that was sent stays sent"). */
  irreversible?: string
  /** Best effort: the reversal relies on the app's own undo. */
  approximate?: boolean
  /** The reversal only makes sense with a browser in front (close tab, go back). */
  needsBrowser?: boolean
}

export interface RecordCtx {
  id: string
  at: number
  taskId: string
  process?: string
  title?: string
  /** The element's value before a set_value (from the turn's UIA snapshot), if known. */
  oldValue?: string
  /** Name of the element a click or uia_act lands on, when known. */
  elementName?: string
}

/** Element names whose click can't be taken back. */
const POINT_OF_NO_RETURN =
  /\b(send|sent|submit|post|publish|reply all|reply|pay|buy|order|purchase|checkout|check out|book|confirm|delete permanently|empty (?:the )?(?:recycle bin|trash)|transfer|sign|tweet|share)\b/i

/** Combos whose effect the app's own undo reverses. */
const APP_UNDOABLE = new Set([
  'ctrl+v',
  'ctrl+x',
  'ctrl+b',
  'ctrl+i',
  'ctrl+u',
  'ctrl+d',
  'delete',
  'backspace',
  'ctrl+backspace',
  'ctrl+delete',
  'ctrl+shift+v',
  'tab'
])
/** Combos that change nothing worth undoing (selection, navigation within a document). */
const HARMLESS = new Set([
  'ctrl+a',
  'ctrl+c',
  'ctrl+f',
  'escape',
  'esc',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'ctrl+home',
  'ctrl+end',
  'f3',
  'alt',
  'win'
])
/** Combos with their own reverse. */
const INVERSE: Record<string, string> = {
  'ctrl+plus': 'ctrl+minus',
  'ctrl+=': 'ctrl+minus',
  'ctrl+minus': 'ctrl+plus',
  'ctrl+-': 'ctrl+plus',
  'ctrl+t': 'ctrl+w',
  'ctrl+n': 'ctrl+w',
  'ctrl+tab': 'ctrl+shift+tab',
  'ctrl+shift+tab': 'ctrl+tab',
  'alt+left': 'alt+right',
  'alt+right': 'alt+left',
  'ctrl+z': 'ctrl+y',
  'ctrl+y': 'ctrl+z'
}
const SENDS = /^(ctrl\+enter|alt\+s|ctrl\+shift\+enter)$/
const IRREVERSIBLE_KEYS: Record<string, string> = {
  'ctrl+s': 'a saved file stays saved (the app’s undo still works on its content)',
  'ctrl+shift+s': 'a file saved under a new name stays on disk',
  'ctrl+p': 'a print job can’t be called back from here',
  'alt+f4': 'a closed window can’t be reopened from here',
  'ctrl+w': 'a closed tab or document can’t be reopened from here',
  'ctrl+q': 'a closed app can’t be reopened from here',
  enter: 'Enter may have sent or confirmed something'
}

/** "Ctrl + Shift + S" / ["ctrl","shift","s"] → "ctrl+shift+s". */
export function normCombo(keys: string | string[]): string {
  const list = Array.isArray(keys) ? keys : keys.split('+')
  return list
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => (k === 'control' ? 'ctrl' : k === 'return' ? 'enter' : k === 'esc' ? 'escape' : k))
    .join('+')
}

const OPPOSITE: Record<ScrollDirection, ScrollDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url.slice(0, 60)
  }
}

function keysRecord(combo: string, base: UndoRecord): UndoRecord {
  const label = combo.replace(/\b\w/g, (c) => c.toUpperCase())
  const what = `pressed ${label}`
  if (HARMLESS.has(combo)) return { ...base, what, reversal: { kind: 'noop' } }
  if (SENDS.test(combo))
    return {
      ...base,
      what,
      reversal: null,
      irreversible: 'that shortcut usually sends, and a sent message stays sent'
    }
  if (INVERSE[combo])
    return { ...base, what, reversal: { kind: 'keys', combo: INVERSE[combo], count: 1 } }
  if (APP_UNDOABLE.has(combo))
    return {
      ...base,
      what,
      reversal: { kind: 'keys', combo: 'ctrl+z', count: 1 },
      approximate: true
    }
  const why = IRREVERSIBLE_KEYS[combo]
  if (why) return { ...base, what, reversal: null, irreversible: why }
  return {
    ...base,
    what,
    reversal: null,
    irreversible: 'I don’t know what that shortcut did in this app'
  }
}

function stepsRecord(steps: InputStep[], base: UndoRecord): UndoRecord {
  const typed = steps.filter((s) => s.t === 'type').length
  const keys = steps.filter((s): s is Extract<InputStep, { t: 'keys' }> => s.t === 'keys')
  const clicks = steps.filter((s) => s.t === 'click' || s.t === 'drag').length
  if (clicks) {
    return {
      ...base,
      what: 'clicked and typed',
      reversal: null,
      irreversible: 'I can’t tell for sure what a click changed'
    }
  }
  const sub = keys.map((k) => keysRecord(normCombo(k.combo), base))
  const bad = sub.find((r) => r.reversal === null)
  if (bad) return { ...bad, what: describeSteps(steps) }
  const undos = typed + sub.filter((r) => r.reversal?.kind === 'keys').length
  if (!undos) return { ...base, what: describeSteps(steps), reversal: { kind: 'noop' } }
  return {
    ...base,
    what: describeSteps(steps),
    reversal: { kind: 'keys', combo: 'ctrl+z', count: undos },
    approximate: true
  }
}

function describeSteps(steps: InputStep[]): string {
  const parts = steps
    .filter((s) => s.t !== 'wait' && s.t !== 'move')
    .map((s) =>
      s.t === 'type'
        ? `typed ${s.text.length} characters`
        : s.t === 'keys'
          ? `pressed ${s.combo}`
          : s.t
    )
  return parts.join(', ') || 'moved the mouse'
}

/** How to reverse `action`; never throws. */
export function reversalFor(action: Action, ctx: RecordCtx): UndoRecord {
  const base: UndoRecord = {
    id: ctx.id,
    at: ctx.at,
    taskId: ctx.taskId,
    what: action.type,
    process: ctx.process?.toLowerCase(),
    title: ctx.title,
    reversal: null
  }
  const name = ctx.elementName
  switch (action.type) {
    case 'move':
    case 'focus_browser':
      return {
        ...base,
        what: action.type === 'move' ? 'moved the mouse' : 'switched to the browser',
        reversal: { kind: 'noop' }
      }
    case 'type':
      return {
        ...base,
        what: `typed ${action.text.length} characters`,
        reversal: { kind: 'keys', combo: 'ctrl+z', count: 1 },
        approximate: true
      }
    case 'hotkey':
      return keysRecord(normCombo(action.keys), base)
    case 'input':
      return stepsRecord(action.steps, base)
    case 'scroll':
      return {
        ...base,
        what: `scrolled ${action.direction}`,
        reversal: {
          kind: 'scroll',
          direction: OPPOSITE[action.direction],
          amount: action.amount ?? 1
        }
      }
    case 'open_url': {
      const what = `opened ${hostOf(action.url)}`
      if (!/^https?:/i.test(action.url))
        return { ...base, what, reversal: null, irreversible: 'it opened in another app' }
      // The new tab is in front once the page loaded: Ctrl+W closes it.
      return {
        ...base,
        what,
        process: undefined,
        needsBrowser: true,
        reversal: { kind: 'keys', combo: 'ctrl+w', count: 1 },
        approximate: true
      }
    }
    case 'navigate_url':
      return {
        ...base,
        what: `went to ${hostOf(action.url)}`,
        process: undefined,
        needsBrowser: true,
        reversal: { kind: 'keys', combo: 'alt+left', count: 1 }
      }
    case 'uia_act':
      return uiaRecord(action.action, action.elementId, action.description ?? name, ctx, base)
    case 'click':
    case 'click_target':
    case 'click_bbox':
    case 'click_element':
    case 'click_nth_element': {
      const label =
        name ??
        ('text' in action ? action.text : undefined) ??
        ('description' in action ? action.description : undefined)
      const what = label ? `clicked “${label.slice(0, 60)}”` : 'clicked'
      if (label && POINT_OF_NO_RETURN.test(label))
        return {
          ...base,
          what,
          reversal: null,
          irreversible: `“${label.slice(0, 40)}” can’t be taken back`
        }
      return {
        ...base,
        what,
        reversal: null,
        irreversible: 'I can’t tell for sure what a click changed'
      }
    }
  }
}

function uiaRecord(
  act: UiaAction,
  elementId: string,
  label: string | undefined,
  ctx: RecordCtx,
  base: UndoRecord
): UndoRecord {
  const el = label ? `“${label.slice(0, 60)}”` : 'a control'
  switch (act) {
    case 'set_value':
      return ctx.oldValue !== undefined
        ? {
            ...base,
            what: `changed ${el}`,
            reversal: { kind: 'set-value', elementId, value: ctx.oldValue }
          }
        : {
            ...base,
            what: `changed ${el}`,
            reversal: { kind: 'keys', combo: 'ctrl+z', count: 1 },
            approximate: true
          }
    case 'toggle':
      return {
        ...base,
        what: `switched ${el}`,
        reversal: { kind: 'uia', elementId, action: 'toggle' }
      }
    case 'expand':
      return {
        ...base,
        what: `opened ${el}`,
        reversal: { kind: 'uia', elementId, action: 'collapse' }
      }
    case 'collapse':
      return {
        ...base,
        what: `closed ${el}`,
        reversal: { kind: 'uia', elementId, action: 'expand' }
      }
    case 'focus':
    case 'scroll_into_view':
      return { ...base, what: `moved to ${el}`, reversal: { kind: 'noop' } }
    case 'select':
      return {
        ...base,
        what: `selected ${el}`,
        reversal: null,
        irreversible: 'I don’t know what was selected before'
      }
    case 'invoke':
    default: {
      if (label && POINT_OF_NO_RETURN.test(label))
        return {
          ...base,
          what: `pressed ${el}`,
          reversal: null,
          irreversible: `${el} can’t be taken back`
        }
      return {
        ...base,
        what: `pressed ${el}`,
        reversal: null,
        irreversible: 'I can’t tell for sure what that button changed'
      }
    }
  }
}

/** A file Lumen overwrote or deleted (backup = the copy in the undo trash; null = created). */
export function fileRecord(
  ctx: Pick<RecordCtx, 'id' | 'at' | 'taskId'>,
  path: string,
  backup: string | null,
  verb: 'changed' | 'deleted' | 'created' | 'moved'
): UndoRecord {
  const base = path.split(/[\\/]/).pop() ?? path
  return {
    id: ctx.id,
    at: ctx.at,
    taskId: ctx.taskId,
    what: `${verb} the file ${base}`,
    reversal: { kind: 'restore-file', path, backup }
  }
}
