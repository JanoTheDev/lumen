// Global keyboard shortcuts for Lumen's a11y actions (06 T17). Pure planning: which keys to
// bind right now (gates), conflicts with Lumen's other shortcuts, and a binder that keeps
// Electron's globalShortcut in step with the plan. install-shortcuts.ts supplies the actions.
import type { A11yShortcutAction, A11yShortcuts, ConfigV2 } from '@shared/config'
import type { ShortcutStatus } from '@shared/channels'

export interface ShortcutGates {
  dwellOn: boolean
  lessonRunning: boolean
}

export const SHORTCUT_LABELS: Record<A11yShortcutAction, string> = {
  focusBar: 'Focus the assistant',
  repeat: 'Repeat the answer',
  pin: 'Pin or unpin the answer',
  close: 'Close the answer',
  numbers: 'Show or hide numbers',
  grid: 'Show or hide the mouse grid',
  dwellPause: 'Pause or resume dwell',
  cancel: 'Cancel',
  keyboard: 'Show or hide the keyboard',
  lessonNext: 'Lesson: next step',
  lessonBack: 'Lesson: previous step',
  lessonHelp: 'Lesson: help',
  lessonDoIt: 'Lesson: do it for me'
}

const LESSON = new Set<A11yShortcutAction>(['lessonNext', 'lessonBack', 'lessonHelp', 'lessonDoIt'])

/** Whether an action's key should be held right now (keys are not taken from apps needlessly). */
export function gateOpen(action: A11yShortcutAction, g: ShortcutGates): boolean {
  if (action === 'dwellPause') return g.dwellOn
  if (LESSON.has(action)) return g.lessonRunning
  return true
}

const ALIASES: Record<string, string> = {
  control: 'ctrl',
  cmdorctrl: 'ctrl',
  commandorcontrol: 'ctrl',
  super: 'win',
  meta: 'win',
  escape: 'esc',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  return: 'enter'
}
const MODS = ['ctrl', 'alt', 'shift', 'win']

/** "Control+shift+F2" and "Ctrl+Shift+F2" compare equal. */
export function normalizeAccelerator(acc: string): string {
  const parts = acc
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .map((p) => ALIASES[p] ?? p)
  const mods = MODS.filter((m) => parts.includes(m))
  return [...mods, ...parts.filter((p) => !MODS.includes(p))].join('+')
}

/** Electron accelerator ("Win" is "Super" there). */
export function toElectron(hotkey: string): string {
  return hotkey
    .split('+')
    .map((k) => (/^win$/i.test(k) ? 'Super' : k))
    .join('+')
}

type ShortcutConfig = Pick<ConfigV2, 'hotkey' | 'dictation' | 'ui'> & {
  a11y: Pick<ConfigV2['a11y'], 'helpHotkey' | 'shortcuts' | 'switch'>
}

/** Lumen's other global keys, which an a11y shortcut must not reuse. */
function reserved(cfg: ShortcutConfig): Map<string, string> {
  const out = new Map<string, string>()
  const add = (key: string | undefined, what: string): void => {
    if (key) out.set(normalizeAccelerator(key), what)
  }
  add(cfg.hotkey, 'the assistant hotkey')
  if (cfg.dictation.enabled) add(cfg.dictation.hotkey, 'the dictation hotkey')
  add(cfg.a11y.helpHotkey, 'the "what can I say" shortcut')
  add(cfg.ui.homeHotkey, 'the Home shortcut')
  if (cfg.a11y.switch.enabled) for (const k of cfg.a11y.switch.keys) add(k, 'a switch key')
  return out
}

export interface PlannedShortcut {
  action: A11yShortcutAction
  accelerator: string
}

/**
 * Status of every action (off, conflict, inactive or wanted) and the keys to bind. The first
 * action in table order keeps a key two actions share.
 */
export function planShortcuts(
  cfg: ShortcutConfig,
  gates: ShortcutGates
): { status: ShortcutStatus[]; bind: PlannedShortcut[] } {
  const taken = reserved(cfg)
  const status: ShortcutStatus[] = []
  const bind: PlannedShortcut[] = []
  const shortcuts: A11yShortcuts = cfg.a11y.shortcuts
  for (const action of Object.keys(SHORTCUT_LABELS) as A11yShortcutAction[]) {
    const accelerator = shortcuts[action] ?? ''
    const base = { action, label: SHORTCUT_LABELS[action], accelerator }
    if (!accelerator) {
      status.push({ ...base, state: 'off' })
      continue
    }
    const key = normalizeAccelerator(accelerator)
    const clash = taken.get(key)
    if (clash) {
      status.push({ ...base, state: 'conflict', with: clash })
      continue
    }
    taken.set(key, SHORTCUT_LABELS[action])
    if (!gateOpen(action, gates)) {
      status.push({ ...base, state: 'inactive' })
      continue
    }
    status.push({ ...base, state: 'bound' })
    bind.push({ action, accelerator })
  }
  return { status, bind }
}

export interface ShortcutRegistry {
  /** False when another app holds the key. May throw for a malformed accelerator. */
  register(accelerator: string, fn: () => void): boolean
  unregister(accelerator: string): void
}

/** Keeps the registered keys equal to the latest plan; remembers keys another app holds. */
export class ShortcutBinder {
  private bound = new Map<string, A11yShortcutAction>()
  private failed = new Set<string>()

  constructor(
    private readonly reg: ShortcutRegistry,
    private readonly run: (action: A11yShortcutAction) => void
  ) {}

  sync(plan: PlannedShortcut[]): void {
    const want = new Map(plan.map((p) => [toElectron(p.accelerator), p.action]))
    for (const [acc, action] of this.bound) {
      if (want.get(acc) === action) continue
      this.reg.unregister(acc)
      this.bound.delete(acc)
    }
    this.failed.clear()
    for (const [acc, action] of want) {
      if (this.bound.has(acc)) continue
      let ok = false
      try {
        ok = this.reg.register(acc, () => this.run(action))
      } catch {
        ok = false
      }
      if (ok) this.bound.set(acc, action)
      else this.failed.add(acc)
    }
  }

  /** The plan's statuses with keys another app holds marked as taken. */
  withFailures(status: ShortcutStatus[]): ShortcutStatus[] {
    return status.map((s) =>
      s.state === 'bound' && this.failed.has(toElectron(s.accelerator))
        ? { ...s, state: 'taken' }
        : s
    )
  }

  clear(): void {
    for (const acc of this.bound.keys()) this.reg.unregister(acc)
    this.bound.clear()
  }
}
