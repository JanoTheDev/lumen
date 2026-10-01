// The app-notes learner of one agent task (05 T36). After each UI call that worked, the path of
// the current plan step (its goal) grows by the element's name / automation id or the shortcut,
// and the note for that goal is saved. When an action on a name from a note fails, the note
// counts a failure (two and it is gone). Typed text and values are never kept, and names of
// content (list items, links, text) only when a lookup named them as UI. No Electron.
import { ocrNorm } from '../query/nth'
import type { AppNote, AppNotePath, AppNotesStore } from './notes'
import type { AppIdentity, HowtoResult } from './types'

/** Ops that follow a UI path (typing, values and scrolling are content, not the path). */
const PATH_OPS = new Set([
  'click',
  'double_click',
  'right_click',
  'invoke',
  'toggle',
  'expand',
  'select',
  'focus'
])
const MAX_GOALS = 12

/**
 * Control roles whose names are UI labels. List items, links, documents and text are content
 * (an email subject, a file name), so their names are kept only when a lookup named them.
 */
const CONTROL_ROLES = new Set([
  'button',
  'splitbutton',
  'menuitem',
  'menu',
  'menubar',
  'tabitem',
  'tab',
  'checkbox',
  'radiobutton',
  'combobox',
  'edit',
  'slider',
  'spinner'
])

export interface LearnedTarget {
  name?: string
  automationId?: string
  /** UIA role when the target is an element ('' / absent for text and marks). */
  role?: string
}

export interface TaskLearner {
  /** A lookup_howto result (notes it returned are watched for failures). */
  looked(id: AppIdentity, r: HowtoResult): void
  /** An act that worked: `op` on `target` while working on `goal`. */
  acted(goal: string, op: string, target: LearnedTarget): Promise<void>
  /** A key combination that worked. */
  pressed(goal: string, combo: string): Promise<void>
  /** An act on `targetName` failed. */
  failed(targetName: string): Promise<void>
}

export interface LearnerPorts {
  /** null while memory is off or private: the learner does nothing. */
  notes(): AppNotesStore | null
  /** The app in front now (null: unknown). */
  identify(): Promise<AppIdentity | null>
  log?(msg: string): void
}

const MAX_PATH = 8

/** Same label after OCR folding and punctuation ("Font…" = "font"). */
export const normLabel = (s: string): string =>
  ocrNorm(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const same = (a: string, b: string): boolean => {
  const x = normLabel(a)
  return !!x && x === normLabel(b)
}

export function createLearner(ports: LearnerPorts): TaskLearner {
  const paths = new Map<string, { appId: string; path: AppNotePath }>()
  const watched: { id: AppIdentity; note: Pick<AppNote, 'goal' | 'path'> }[] = []
  /** UI names a lookup returned in this task (documented labels, safe to keep). */
  const known = new Set<string>()
  const isLabel = (t: LearnedTarget): boolean =>
    CONTROL_ROLES.has((t.role ?? '').toLowerCase()) || (!!t.name && known.has(normLabel(t.name)))

  async function grow(goal: string, add: (p: AppNotePath) => void): Promise<void> {
    const store = ports.notes()
    const g = goal.trim()
    if (!store || !g) return
    const id = await ports.identify()
    if (!id) return
    let entry = paths.get(g)
    if (!entry || entry.appId !== id.appId) {
      if (!entry && paths.size >= MAX_GOALS) return
      entry = { appId: id.appId, path: { ui: [] } }
      paths.set(g, entry)
    }
    add(entry.path)
    if (store.recordSuccess(id, g, entry.path))
      ports.log?.(`app notes: kept a path for "${g}" in ${id.appId}`)
  }

  return {
    looked(id, r) {
      for (const s of r.steps) for (const u of s.ui) known.add(normLabel(u))
      if (r.from !== 'notes') return
      watched.push({ id, note: { goal: r.goal, path: { ui: r.steps.flatMap((s) => s.ui) } } })
    },
    acted: (goal, op, target) =>
      PATH_OPS.has(op) && (target.name || target.automationId) && isLabel(target)
        ? grow(goal, (p) => {
            const last = p.ui[p.ui.length - 1]
            if (target.name && p.ui.length < MAX_PATH && (!last || !same(last, target.name)))
              p.ui.push(target.name)
            const ids = p.automationIds ?? []
            if (target.automationId && ids.length < MAX_PATH && !ids.includes(target.automationId))
              p.automationIds = [...ids, target.automationId]
          })
        : Promise.resolve(),
    pressed: (goal, combo) =>
      /\b(ctrl|alt|win|shift)\b/i.test(combo)
        ? grow(goal, (p) => {
            p.shortcut = combo
          })
        : Promise.resolve(),
    async failed(targetName) {
      const store = ports.notes()
      if (!store || !targetName) return
      for (const w of watched) {
        if (!w.note.path.ui.some((u) => same(u, targetName))) continue
        const dropped = store.recordFailure(w.id, w.note.goal)
        ports.log?.(
          `app notes: "${w.note.goal}" failed on "${targetName}"${dropped ? ', note removed' : ''}`
        )
      }
    }
  }
}
