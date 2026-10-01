// Face-gesture input (11 T25), Electron side. While a11y.face.enabled is on (and the model
// is installed) a hidden face window runs the camera and sends gesture scores; closing it
// is what turns the camera off. Gestures act through the paths dwell and switch use:
// clicks / scrolls at the pointer go through the input lane and the executor's policy gate
// (origin user-direct), switch presses to the 06 scanner, dwell pause to the dwell
// controller, voice like the wake word.
import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import type { FaceAssets } from '@shared/channels'
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
import { faceInstalled, installFaceFiles, readFaceFiles } from './assets'
import { FaceController } from './controller'
import { runFaceAction, type FaceActionDeps } from './actions'
import { GESTURE_LABEL } from './gestures'

let win: BrowserWindow | null = null
let controller: FaceController | null = null
let installing: number | undefined
/** One action at a time: a gesture while the last one still runs is dropped. */
let acting = false

const faceCfg = (): ReturnType<typeof loadConfig>['a11y']['face'] => loadConfig().a11y.face

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
  voice: () => handleWake('face')
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
  })
  w.webContents.on('render-process-gone', () => {
    controller?.setStatus('error', 'The face gesture window stopped.')
  })
  loadRenderer(w, 'face')
  log('step', 'face gestures: camera window opened')
}

function close(): void {
  const w = win
  win = null
  if (w && !w.isDestroyed()) w.destroy()
  controller?.setStatus('off')
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
    if (f) c.onFrame(f)
  })
  ipcMain.on('face:status', (e, raw: unknown) => {
    if (!fromFace(e)) return
    const s = safeParse('face:status', faceStatusSchema, raw)
    if (!s) return
    c.setStatus(s.state, s.error)
    if (s.state === 'error') log('fail', `face gestures: ${s.error ?? 'error'}`)
    else log('step', 'face gestures: running')
  })
  ipcMain.handle('face:state', () => c.state(faceInstalled(), installing))
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
    return step.step === 'rest' ? c.calibrateRest() : c.calibrateGesture(step.gesture)
  })

  onConfigPatched((next, prev) => {
    const a = next.a11y.face
    const b = prev.a11y.face
    if (a.cameraId !== b.cameraId && win) close()
    if (JSON.stringify(a) !== JSON.stringify(b)) c.reconfigure()
    sync()
  })
  sync()
}
