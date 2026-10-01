// Electron side of switch scanning (06 T09) and the scan keyboard (T10): switch keys,
// the scan ring / menu on the screen layer, the keyboard window and the scan tree's links
// to numbers, the grid, the agent and Lumen's own actions. installA11y() calls it.
//
// Switch keys are bound only while scanning is on. With an agent that reports `switch` they
// live on its low-level keyboard hook (`switch_keys`): the physical key is suppressed down and
// up, auto-repeat is swallowed and injected keys pass through. Otherwise they fall back to
// Electron global shortcuts (RegisterHotKey: suppressed, but a held key repeats and our own
// typed keys clash). Gamepad switches are not supported.
import { globalShortcut, screen } from 'electron'
import type { InputStep } from '@shared/types'
import { bus } from '../bus'
import { loadConfig, type AppConfig } from '../config'
import { log } from '../logger'
import { logicalToPhys, physRectToLogical } from '../actions/coords'
import * as commands from '../agent/commands'
import { getAgent, requireAgent } from '../agent/instance'
import { onConfigPatched } from '../ipc/settings'
import { cancelAll } from '../query/cancel'
import { handleWake } from '../speech/wake/handlers'
import * as assistant from '../windows/assistant'
import * as commandSheet from '../windows/command-sheet'
import * as scanKeyboard from '../windows/scan-keyboard'
import * as screenLayer from '../windows/screen-layer'
import * as settingsWin from '../windows/settings'
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
function switchAccelerator(key: string): string {
  const k = key.trim()
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase()
  if (k.length === 1) return k.toUpperCase()
  return k[0].toUpperCase() + k.slice(1)
}

/** The running agent when it can hold switch keys on its hook. */
function switchHook(): ReturnType<typeof getAgent> {
  const agent = getAgent()
  return agent?.running && agent.hasCapability('switch') ? agent : null
}

export function installSwitch(deps: SwitchInstallDeps): SwitchControl {
  /** Keys held as Electron global shortcuts (fallback). */
  let bound: string[] = []
  /** Keys held on the agent hook. */
  let hooked = false
  /** Scanning is on, so switch keys should be bound. */
  let wanted = false
  let lastRaw = -Infinity
  let lessonRunning = false
  bus.on('lesson.step-started', () => (lessonRunning = true))
  bus.on('lesson.done', () => (lessonRunning = false))

  const releaseShortcuts = (): void => {
    for (const k of bound) globalShortcut.unregister(k)
    bound = []
  }

  const unbind = (): void => {
    wanted = false
    releaseShortcuts()
    const agent = switchHook()
    if (hooked && agent) {
      commands
        .switchKeys(agent, [])
        .catch((e: Error) => log('skip', `switch keys release failed (${e.message})`))
    }
    hooked = false
  }

  const press = (i: number): void => {
    const mode = scanSettings(loadConfig()).mode
    const role: SwitchRole = mode === 'step' && i === 0 ? 'next' : 'select'
    scanner.press(role)
  }

  /** Global shortcut: no key-up, so auto-repeat is filtered by timing. */
  const onShortcut = (i: number): void => {
    const now = Date.now()
    const gap = now - lastRaw
    lastRaw = now
    if (gap < REPEAT_GAP_MS) return
    press(i)
  }

  const bindShortcuts = (accels: string[]): void => {
    releaseShortcuts()
    accels.forEach((acc, i) => {
      try {
        if (globalShortcut.register(acc, () => onShortcut(i))) bound.push(acc)
        else log('skip', `switch key ${acc} is taken by another app`)
      } catch (e) {
        log('fail', `switch key ${acc} rejected (${(e as Error).message})`)
      }
    })
    if (!bound.length) deps.feedback('No switch key could be set up', false)
  }

  const bind = (): void => {
    wanted = true
    const accels = loadConfig().a11y.switch.keys.map(switchAccelerator)
    const agent = switchHook()
    if (!agent) {
      hooked = false
      bindShortcuts(accels)
      return
    }
    releaseShortcuts()
    hooked = true
    commands.switchKeys(agent, accels).catch((e: Error) => {
      log('fail', `switch keys on the agent hook failed (${e.message}); using global shortcuts`)
      hooked = false
      if (wanted) bindShortcuts(accels)
    })
  }

  const agent = getAgent()
  agent?.onEvent('switch', (data) => {
    const { index, down } = (data ?? {}) as { index?: unknown; down?: unknown }
    if (hooked && down === true && typeof index === 'number' && Number.isInteger(index))
      press(index)
  })
  // A restarted agent has no switch keys; a native one may now take over from the shortcuts.
  agent?.onEvent('agent-ready', () => {
    if (wanted) bind()
  })

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
      if (assistant.answerShown()) {
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
