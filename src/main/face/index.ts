// Face-gesture input (11 T25), Electron side. While a11y.face.enabled is on (and the model
// is installed) a hidden face window runs the camera and sends gesture scores; closing it
// is what turns the camera off. Gestures act through the paths dwell and switch use:
// clicks / scrolls at the pointer go through the input lane and the executor's policy gate
// (origin user-direct), switch presses to the 06 scanner, dwell pause to the dwell
// controller, voice like the wake word.
// Head pointer (a11y.face.pointer): head yaw / pitch move the pointer through the agent's
// `input` move (input lane, user-direct, so an agent holding the lane pauses like for the
// user's own mouse), at most 30 moves a second, only while the camera runs.
import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import type { FaceAssets, FaceState } from '@shared/channels'
import type { FaceAction, FaceGesture } from '@shared/config'
import { faceCalibrateSchema, faceFrameSchema, faceStatusSchema } from '@shared/ipc'
import { loadConfig } from '../config'
import { log } from '../logger'
import { INVALID, safeParse } from '../ipc/validate'
import { onConfigPatched, patchConfig } from '../ipc/settings'
import { createWindow, loadRenderer } from '../windows/factory'
import { executeActions } from '../actions/executor'
import { logicalToPhys } from '../actions/coords'
import { withInputLane } from '../agent-mode/input-lane'
import { dwellController } from '../a11y/dwell'
import { announce, switchControl } from '../a11y'
import { handleWake } from '../speech/wake/handlers'
import { getAgent } from '../agent/instance'
import * as commands from '../agent/commands'
import { faceInstalled, installFaceFiles, readFaceFiles } from './assets'
import { FaceController } from './controller'
import { runFaceAction, type FaceActionDeps } from './actions'
import { GESTURE_LABEL } from './gestures'
import { HeadPointer, TICK_MS } from './pointer'
import { parsePointerCommand } from './voice'

let win: BrowserWindow | null = null
let controller: FaceController | null = null
let installing: number | undefined
/** One action at a time: a gesture while the last one still runs is dropped. */
let acting = false
let pointerTimer: ReturnType<typeof setInterval> | null = null
const MOVE_TIMEOUT_MS = 1000

const faceCfg = (): ReturnType<typeof loadConfig>['a11y']['face'] => loadConfig().a11y.face

const pointerOn = (): boolean => faceCfg().enabled && faceCfg().pointer.enabled

const headPointer = new HeadPointer({
  config: () => faceCfg().pointer,
  cursor: () => screen.getCursorScreenPoint(),
  clamp: (p) => {
    const b = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }).bounds
    return {
      x: Math.min(b.x + b.width - 1, Math.max(b.x, p.x)),
      y: Math.min(b.y + b.height - 1, Math.max(b.y, p.y))
    }
  },
  bounds: () => {
    const b = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  },
  move: async (p) => {
    const agent = getAgent()
    if (!agent) return
    const at = logicalToPhys(p)
    await withInputLane(
      'face',
      () =>
        commands.input(agent, [{ t: 'move', x: Math.round(at.x), y: Math.round(at.y) }], {
          timeoutMs: MOVE_TIMEOUT_MS
        }),
      { user: true }
    )
  }
})

/** The tick timer runs only while the pointer is on and the camera runs. */
function syncPointerTimer(): void {
  const want = pointerOn() && controller?.status === 'running'
  if (want && !pointerTimer) {
    pointerTimer = setInterval(() => {
      // Holds still while calibrating and while a gesture's click runs.
      if (!controller?.calibrating && !acting) headPointer.tick(Date.now())
    }, TICK_MS)
  } else if (!want && pointerTimer) {
    clearInterval(pointerTimer)
    pointerTimer = null
    headPointer.reset()
  }
}

function setPointerPaused(paused: boolean): void {
  headPointer.setPaused(paused)
  announce(paused ? 'Head pointer paused' : 'Head pointer on', { kind: 'command' })
}

const fromFace = (e: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  !!win && !win.isDestroyed() && e.sender.id === win.webContents.id

const actionDeps: FaceActionDeps = {
  input: async (steps) => {
    // At the pointer, so a stray dwell / scan target never moves it.
    const at = logicalToPhys(screen.getCursorScreenPoint())
    const placed = steps.map((s) =>
      s.t === 'click' || s.t === 'scroll' ? { ...s, x: Math.round(at.x), y: Math.round(at.y) } : s
    )
    const r = await withInputLane(
      'face',
      () =>
        executeActions([{ type: 'input', steps: placed }], {
          origin: 'user-direct',
          preview: false,
          refine: false
        }),
      { user: true }
    )
    return r.executed > 0 && !r.blocked && !r.cancelled
  },
  switchPress: (role) => switchControl()?.scanner.press(role) ?? false,
  toggleDwellPause: () => {
    const d = dwellController()
    if (!d?.state().enabled) return false
    d.setPaused(!d.paused)
    announce(d.paused ? 'Dwell paused' : 'Dwell on', { kind: 'command' })
    return true
  },
  voice: () => handleWake('face'),
  pointerPause: () => {
    if (!pointerOn()) return false
    setPointerPaused(!headPointer.paused)
    return true
  },
  pointerRecentre: () => {
    if (!pointerOn() || !headPointer.recentre()) return false
    announce('Pointer centred', { kind: 'command' })
    return true
  }
}

function run(action: FaceAction, gesture: FaceGesture): void {
  if (acting) return
  acting = true
  log('step', `face: ${gesture} → ${action}`)
  runFaceAction(action, actionDeps)
    .then((r) => {
      if (!r.ok && r.why) announce(`${GESTURE_LABEL[gesture]}: ${r.why}`, { kind: 'command' })
    })
    .catch((e: Error) => log('fail', `face action ${action} failed: ${e.message}`))
    .finally(() => (acting = false))
}

function open(): void {
  if (win && !win.isDestroyed()) return
  controller?.setStatus('starting')
  const w = createWindow({
    show: false,
    width: 320,
    height: 240,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    title: 'Lumen face gestures'
  })
  win = w
  w.on('closed', () => {
    if (win === w) win = null
    controller?.setStatus('off')
    syncPointerTimer()
  })
  w.webContents.on('render-process-gone', () => {
    controller?.setStatus('error', 'The face gesture window stopped.')
    syncPointerTimer()
  })
  loadRenderer(w, 'face')
  log('step', 'face gestures: camera window opened')
}

function close(): void {
  const w = win
  win = null
  if (w && !w.isDestroyed()) w.destroy()
  controller?.setStatus('off')
  syncPointerTimer()
}

function sync(): void {
  const on = faceCfg().enabled && faceInstalled()
  if (on) open()
  else if (win) {
    close()
    log('step', 'face gestures: camera window closed')
  }
}

export function installFace(): void {
  if (controller) return
  controller = new FaceController({
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    config: faceCfg,
    run,
    saveThreshold: (g, t) => {
      const face = faceCfg()
      void patchConfig({ a11y: { face: { ...face, thresholds: { ...face.thresholds, [g]: t } } } })
    },
    saveRange: (range) => {
      const face = faceCfg()
      void patchConfig({ a11y: { face: { ...face, pointer: { ...face.pointer, range } } } })
    }
  })
  const c = controller

  ipcMain.handle('face:assets', (e): FaceAssets => {
    if (!fromFace(e)) return { ok: false, error: 'not the face window' }
    try {
      return { ok: true, ...readFaceFiles(), cameraId: faceCfg().cameraId }
    } catch (err) {
      return { ok: false, error: `face model missing (${(err as Error).message})` }
    }
  })
  ipcMain.on('face:frame', (e, raw: unknown) => {
    if (!fromFace(e)) return
    const f = safeParse('face:frame', faceFrameSchema, raw)
    if (!f) return
    c.onFrame(f)
    if (pointerTimer && !c.calibrating) headPointer.onFrame(f)
  })
  ipcMain.on('face:status', (e, raw: unknown) => {
    if (!fromFace(e)) return
    const s = safeParse('face:status', faceStatusSchema, raw)
    if (!s) return
    c.setStatus(s.state, s.error)
    syncPointerTimer()
    if (s.state === 'error') log('fail', `face gestures: ${s.error ?? 'error'}`)
    else log('step', 'face gestures: running')
  })
  ipcMain.handle('face:state', (): FaceState => {
    const st = c.state(faceInstalled(), installing)
    return pointerTimer ? { ...st, pointer: headPointer.view() } : st
  })
  ipcMain.handle('face:install', async () => {
    if (installing !== undefined) return { ok: false, error: 'already downloading' }
    installing = 0
    try {
      await installFaceFiles((p) => (installing = p))
      sync()
      return { ok: true }
    } catch (e) {
      log('fail', `face model download failed: ${(e as Error).message}`)
      return { ok: false, error: (e as Error).message }
    } finally {
      installing = undefined
    }
  })
  ipcMain.handle('face:calibrate', async (_e, raw: unknown) => {
    const step = safeParse('face:calibrate', faceCalibrateSchema, raw)
    if (!step) return INVALID
    if (step.step === 'range') return c.calibrateRange(step.at)
    return step.step === 'rest' ? c.calibrateRest() : c.calibrateGesture(step.gesture)
  })

  onConfigPatched((next, prev) => {
    const a = next.a11y.face
    const b = prev.a11y.face
    if (a.cameraId !== b.cameraId && win) close()
    if (JSON.stringify(a) !== JSON.stringify(b)) c.reconfigure()
    if (
      a.pointer.enabled !== b.pointer.enabled ||
      JSON.stringify(a.pointer.range) !== JSON.stringify(b.pointer.range)
    ) {
      headPointer.reset()
      headPointer.paused = false
    }
    sync()
    syncPointerTimer()
  })
  sync()
}

/**
 * Voice: "recentre", "pause / resume the head pointer", "head pointer on / off". Claims
 * "recentre" and pause / resume only while the pointer is on.
 */
export function interceptFace(prompt: string): unknown | undefined {
  const cmd = parsePointerCommand(prompt)
  if (!cmd) return undefined
  const answer = (text: string): { mode: 'answer'; text: string } => ({ mode: 'answer', text })
  const face = faceCfg()
  if (cmd === 'on' || cmd === 'off') {
    if (cmd === 'on' && !faceInstalled())
      return answer(
        'The head pointer needs the face model. Download it in Settings, Accessibility, face gestures.'
      )
    const enabled = cmd === 'on'
    void patchConfig({
      a11y: {
        face: { ...face, enabled: enabled || face.enabled, pointer: { ...face.pointer, enabled } }
      }
    })
    return answer(
      enabled ? 'Head pointer on. Say recentre to set the centre.' : 'Head pointer off.'
    )
  }
  if (!pointerOn()) return cmd === 'recentre' ? undefined : answer('The head pointer is off.')
  if (cmd === 'recentre')
    return answer(headPointer.recentre() ? 'Pointer centred.' : 'I cannot see your face right now.')
  headPointer.setPaused(cmd === 'pause')
  return answer(cmd === 'pause' ? 'Head pointer paused.' : 'Head pointer on.')
}
