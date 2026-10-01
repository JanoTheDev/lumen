// Focus mode wired to the app (11 T14): the screen layer draws the dim mask, the teach
// registry gives the app pack's regions, lesson scenes drive the automatic mode.
import { bus } from '../bus'
import { loadConfig } from '../config'
import { physRectToLogical } from '../actions/coords'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { onConfigPatched } from '../ipc/settings'
import { skillRegistry } from '../teach'
import * as screenLayer from '../windows/screen-layer'
import { FocusController, type FocusIo } from './controller'

const FOREGROUND_TIMEOUT_MS = 1500
/** A manual focus follows its window while on (moved, resized, another app in front). */
const FOLLOW_MS = 2000

let controller: FocusController | null = null
let followTimer: ReturnType<typeof setInterval> | null = null

const io: FocusIo = {
  async foreground() {
    const agent = getAgent()
    if (!agent) return null
    const w = await commands
      .activeWindow(agent, { timeoutMs: FOREGROUND_TIMEOUT_MS })
      .catch(() => null)
    return w?.rect ? { rect: w.rect, process: w.process || w.exe, title: w.title } : null
  },
  regions(win) {
    const skill = skillRegistry()?.matchApp(win)
    return skill && Object.keys(skill.regions).length ? skill.regions : null
  },
  physRectToLogical,
  draw(scene) {
    if (scene) screenLayer.create()
    screenLayer.setScene({ focus: scene ?? undefined })
  },
  level: () => loadConfig().helpers.focusLevel,
  autoWithLessons: () => loadConfig().helpers.focusWithLessons
}

function syncFollow(): void {
  const want = !!controller?.manual
  if (want && !followTimer) followTimer = setInterval(() => void controller?.refresh(), FOLLOW_MS)
  else if (!want && followTimer) {
    clearInterval(followTimer)
    followTimer = null
  }
}

export function focusController(): FocusController | null {
  return controller
}

export async function focusOn(opts: Parameters<FocusController['on']>[0] = {}): Promise<string> {
  if (!controller) return 'Focus mode is not ready yet.'
  const r = await controller.on(opts)
  syncFollow()
  return r.text
}

export function focusOff(): string {
  if (!controller) return 'Nothing is dimmed.'
  const r = controller.off()
  syncFollow()
  return r.text
}

/** Call once at startup. */
export function installFocus(): void {
  if (controller) return
  controller = new FocusController(io)
  bus.on('lesson.scene', (e) => {
    const rects = e.scene?.highlights.map((h) => h.rect) ?? null
    controller?.lessonTargets(rects)
  })
  bus.on('lesson.done', () => controller?.lessonTargets(null))
  onConfigPatched(() => void controller?.settingsChanged())
}
