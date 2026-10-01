// Electron side of the a11y shortcuts (06 T17): binds the planned keys with globalShortcut,
// re-plans on config / dwell / lesson changes, and runs each action. installA11y() calls it.
import { globalShortcut } from 'electron'
import type { A11yShortcutAction } from '@shared/config'
import type { ShortcutStatus } from '@shared/channels'
import type { LessonCommand } from '@shared/events'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'
import { onConfigPatched } from '../ipc/settings'
import { cancelAll } from '../query/cancel'
import * as assistant from '../windows/assistant'
import * as home from '../windows/home'
import { uiV2 } from '../windows/ui-mode'
import type { A11yCommands } from './dispatch'
import { dwellController } from './dwell'
import { syncHelpShortcut } from './help'
import { ShortcutBinder, planShortcuts, type ShortcutGates } from './shortcuts'

export interface ShortcutInstallDeps {
  commands: () => A11yCommands | null
  toggleKeyboard: () => void
  feedback: (text: string, ok: boolean) => void
}

const LESSON: Partial<Record<A11yShortcutAction, LessonCommand>> = {
  lessonNext: 'next',
  lessonBack: 'back',
  lessonHelp: 'help',
  lessonDoIt: 'do-it'
}

export function installShortcuts(deps: ShortcutInstallDeps): { status: () => ShortcutStatus[] } {
  let lessonRunning = false

  const answer = (op: 'repeat' | 'pin' | 'close'): void => {
    if (!uiV2() || !assistant.answerShown()) {
      deps.feedback('No answer is showing', false)
      return
    }
    if (op === 'close') assistant.close()
    else assistant.command({ type: op })
  }

  const run = (action: A11yShortcutAction): void => {
    const a11y = deps.commands()
    log('plan', `shortcut ${action}`)
    switch (action) {
      case 'focusBar':
        if (uiV2() && assistant.focusBar()) return
        if (home.get()) {
          home.show()
          home.send('home:ask')
        } else deps.feedback('Nothing to focus. Press the assistant hotkey to ask', false)
        return
      case 'repeat':
      case 'pin':
      case 'close':
        return answer(action)
      case 'numbers':
        if (!a11y) return
        if (a11y.marks.shown) a11y.hideMarks()
        else
          a11y
            .showMarks('foreground', undefined)
            .catch((e: Error) => deps.feedback(e.message || 'No numbers here', false))
        return
      case 'grid':
        if (!a11y) return
        if (a11y.grid.shown) {
          a11y.grid.close()
          a11y.renderGrid()
        } else a11y.showGrid()
        return
      case 'dwellPause': {
        const dwell = dwellController()
        if (!dwell?.setPaused(!dwell.state().paused)) deps.feedback('Dwell clicking is off', false)
        return
      }
      case 'cancel':
        cancelAll()
        bus.emit({ type: 'voice.cancelled' })
        return
      case 'keyboard':
        return deps.toggleKeyboard()
      default: {
        const command = LESSON[action]
        if (command) bus.emit({ type: 'lesson.command', command })
      }
    }
  }

  const binder = new ShortcutBinder(
    {
      register: (acc, fn) => globalShortcut.register(acc, fn),
      unregister: (acc) => globalShortcut.unregister(acc)
    },
    (action) => {
      // Runs inside globalShortcut's callback: a UserError ("No screen found") becomes feedback.
      try {
        run(action)
      } catch (e) {
        deps.feedback((e as Error).message || 'That did not work', false)
      }
    }
  )

  const gates = (): ShortcutGates => ({
    dwellOn: loadConfig().dwellClick.enabled,
    lessonRunning
  })
  let status: ShortcutStatus[] = []
  const sync = (): void => {
    const plan = planShortcuts(loadConfig(), gates())
    binder.sync(plan.bind)
    // A new help key an a11y shortcut held until now was refused on its own config event.
    syncHelpShortcut()
    status = binder.withFailures(plan.status)

    for (const s of status) {
      if (s.state === 'conflict')
        log('skip', `shortcut ${s.accelerator} (${s.action}) clashes with ${s.with}`)
      if (s.state === 'taken') log('skip', `shortcut ${s.accelerator} is taken by another app`)
    }
  }

  bus.on('lesson.step-started', () => {
    if (lessonRunning) return
    lessonRunning = true
    sync()
  })
  bus.on('lesson.done', () => {
    lessonRunning = false
    sync()
  })
  onConfigPatched(() => sync())
  sync()
  return { status: () => status }
}
