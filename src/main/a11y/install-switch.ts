// Electron side of switch scanning (06 T09) and the scan keyboard (T10): switch keys,
// the scan ring / menu on the screen layer, the keyboard window and the scan tree's links
// to numbers, the grid, the agent and Lumen's own actions. installA11y() calls it.
//
// Switch keys are global shortcuts for now (RegisterHotKey): Windows hands the key to Lumen
// only, so Space does not also type into the app. They are bound only while scanning is on.
// Key-up, held-key and mouse/gamepad switches need the agent hook (requested from 02).
import { globalShortcut, screen } from 'electron'
import type { InputStep } from '@shared/types'
import { bus } from '../bus'
import { loadConfig, type AppConfig } from '../config'
import { log } from '../logger'
import { logicalToPhys, physRectToLogical } from '../actions/coords'
import * as commands from '../agent/commands'
import { requireAgent } from '../agent/instance'
import { onConfigPatched } from '../ipc/settings'
import { cancelAll } from '../query/cancel'
import { handleWake } from '../speech/wake/handlers'
import * as assistant from '../windows/assistant'
import * as commandSheet from '../windows/command-sheet'
import * as scanKeyboard from '../windows/scan-keyboard'
import * as screenLayer from '../windows/screen-layer'
import * as settingsWin from '../windows/settings'
import { uiV2 } from '../windows/ui-mode'
import type { A11yCommands } from './dispatch'
import { ScanKeyboardModel, keyboardScanLevel } from './keyboard'
import { ScanTree } from './scan-tree'
import { Scanner, toScanScene, type ScanSettings, type SwitchRole } from './switch'

const INPUT_TIMEOUT_MS = 15_000
/** Key auto-repeat arrives faster than this; a held key counts once (until the repeat delay). */
const REPEAT_GAP_MS = 120

export interface SwitchInstallDeps {
  commands: () => A11yCommands | null
  announce: (text: string) => void
  /** Status / announcement for an action's result. */
  feedback: (text: string, ok: boolean) => void
}

export interface SwitchControl {
  /** Voice "start/stop scanning": on binds the keys and starts, off releases them. */
  setScanning(on: boolean): boolean
  /** Mouse / dwell click on a scan keyboard key. */
  keyboardKey(id: string): void
  keyboardState(): ReturnType<ScanKeyboardModel['state']>
  /** Opens or hides the keyboard outside scanning (dwell palette, shortcut). */
  toggleKeyboard(): void
  scanner: Scanner
}

function scanSettings(cfg: AppConfig): ScanSettings {
  const s = cfg.a11y.switch
  return {
    mode: s.mode === 'step' && s.keys.length >= 2 ? 'step' : 'auto',
    intervalMs: s.scanIntervalMs,
    loops: s.loops
  }
}

/** Config key name → Electron accelerator ("space" → "Space", "f8" → "F8"). */
export function switchAccelerator(key: string): string {
  const k = key.trim()
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase()
  if (k.length === 1) return k.toUpperCase()
  return k[0].toUpperCase() + k.slice(1)
}

export function installSwitch(deps: SwitchInstallDeps): SwitchControl {
  let bound: string[] = []
  let lastRaw = -Infinity
  let lessonRunning = false
  bus.on('lesson.step-started', () => (lessonRunning = true))
  bus.on('lesson.done', () => (lessonRunning = false))

  const unbind = (): void => {
    for (const k of bound) globalShortcut.unregister(k)
    bound = []
  }

  const onKey = (i: number): void => {
    const now = Date.now()
    const gap = now - lastRaw
    lastRaw = now
    if (gap < REPEAT_GAP_MS) return
    const mode = scanSettings(loadConfig()).mode
    const role: SwitchRole = mode === 'step' && i === 0 ? 'next' : 'select'
    scanner.press(role)
  }

  const bind = (): void => {
    unbind()
    loadConfig().a11y.switch.keys.forEach((key, i) => {
      const acc = switchAccelerator(key)
      try {
        if (globalShortcut.register(acc, () => onKey(i))) bound.push(acc)
        else log('skip', `switch key ${acc} is taken by another app`)
      } catch (e) {
        log('fail', `switch key ${acc} rejected (${(e as Error).message})`)
      }
    })
    if (!bound.length) deps.feedback('No switch key could be set up', false)
  }

  /** A typed key that is also a switch key would be swallowed by the hotkey: release it. */
  const runInput = async (steps: InputStep[]): Promise<void> => {
    const clash = steps.some(
      (s) => s.t === 'keys' && bound.some((k) => k.toLowerCase() === s.combo.toLowerCase())
    )
    const keep = clash ? [...bound] : []
    if (clash) unbind()
    try {
      await commands.input(requireAgent(), steps, { timeoutMs: INPUT_TIMEOUT_MS })
    } finally {
      if (clash && keep.length && scanner.state !== 'off') bind()
    }
  }

  const kb = new ScanKeyboardModel()
  const renderKeyboard = (): void => scanKeyboard.sendState(kb.state())
  const pressKey = async (id: string): Promise<void> => {
    const r = kb.press(id)
    renderKeyboard()
    if (r.close) {
      scanKeyboard.hide()
      return
    }
    if (r.steps.length) await runInput(r.steps)
  }
  const openKeyboard = (): void => {
    kb.reset()
    renderKeyboard()
    scanKeyboard.show()
  }

  const a11y = (): A11yCommands => {
    const c = deps.commands()
    if (!c) throw new Error('voice commands are not installed')
    return c
  }

  const tree = new ScanTree({
    showNumbers: async () => {
      try {
        await a11y().showMarks('foreground', undefined)
      } catch (e) {
        log('skip', `scan numbers: ${(e as Error).message}`)
        return 0
      }
      return a11y().marks.visible().length
    },
    numbers: () => {
      const m = a11y().marks
      if (!m.shown) return []
      return m
        .visible()
        .map((v) => ({ n: v.n, label: v.label, rect: physRectToLogical(v.physRect) }))
    },
    hideNumbers: () => {
      if (!loadConfig().a11y.marks.keep) a11y().hideMarks()
    },
    showGrid: () => a11y().showGrid(undefined, { quiet: true }),
    grid: () => a11y().grid.scene(),
    gridSelect: (n) => {
      const ok = a11y().grid.select(n)
      a11y().renderGrid()
      return ok
    },
    gridUp: () => {
      const ok = a11y().grid.up()
      a11y().renderGrid()
      return ok
    },
    gridAtMinimum: () => a11y().grid.atMinimum,
    closeGrid: () => {
      a11y().grid.close()
      a11y().renderGrid()
    },
    input: runInput,
    logicalToPhys,
    keyboard: () => {
      openKeyboard()
      return keyboardScanLevel(kb, {
        press: pressKey,
        close: () => scanKeyboard.hide(),
        render: renderKeyboard
      })
    },
    lumenActions: () => {
      const out: { label: string; run(): void }[] = [
        { label: 'Ask by voice', run: () => handleWake('switch') }
      ]
      if (uiV2() && assistant.answerShown()) {
        out.push(
          { label: 'Repeat answer', run: () => assistant.command({ type: 'repeat' }) },
          { label: 'Pin answer', run: () => assistant.pinAnswer(true) },
          { label: 'Close answer', run: () => assistant.close() }
        )
      }
      out.push(
        {
          label: 'Cancel',
          run: () => {
            cancelAll()
            bus.emit({ type: 'voice.cancelled' })
          }
        },
        { label: 'What can I say', run: () => commandSheet.show() },
        { label: 'Settings', run: () => settingsWin.create() }
      )
      return out
    },
    lessonRunning: () => lessonRunning,
    lessonCommand: (command) => bus.emit({ type: 'lesson.command', command }),
    feedback: deps.feedback
  })

  const scanner = new Scanner({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    settings: () => scanSettings(loadConfig()),
    root: () => tree.root(),
    render: (view) => {
      const scan = toScanScene(view, screen.getCursorScreenPoint())
      screenLayer.create()
      screenLayer.setScene({ scan })
    },
    announce: deps.announce,
    log: (msg) => log('plan', msg)
  })

  const turnOn = (): void => {
    bind()
    if (scanner.state === 'off') scanner.idle(true)
  }
  const turnOff = (): void => {
    scanner.stop()
    unbind()
    tree.dragFrom = null
  }

  // Escape / voice cancel took numbers and the grid away: start over at the top.
  bus.on('voice.cancelled', () => {
    if (scanner.state === 'scanning') scanner.start()
  })

  onConfigPatched((next, prev) => {
    const a = next.a11y.switch
    const b = prev.a11y.switch
    if (!a.enabled && b.enabled) turnOff()
    else if (a.enabled && !b.enabled) {
      turnOn()
      scanner.start()
    } else if (a.enabled && JSON.stringify(a.keys) !== JSON.stringify(b.keys)) bind()
  })
  if (loadConfig().a11y.switch.enabled) turnOn()

  return {
    scanner,
    setScanning: (on) => {
      if (on) {
        turnOn()
        scanner.start()
      } else turnOff()
      return true
    },
    keyboardKey: (id) => {
      pressKey(id).catch((e: Error) => deps.feedback(`Key failed: ${e.message}`, false))
    },
    keyboardState: () => kb.state(),
    toggleKeyboard: () => {
      if (scanKeyboard.isVisible()) scanKeyboard.hide()
      else openKeyboard()
    }
  }
}
