// Electron side of dwell v2 (06 T08): the real DwellIo (agent, coords, screen layer, palette,
// a cached UIA snapshot for snapping) and the config / focus wiring. installA11y() calls it.
import { screen } from 'electron'
import type { ElementNode, InputStep } from '@shared/types'
import { bus } from '../bus'
import { loadConfig, type AppConfig } from '../config'
import { log } from '../logger'
import { logicalToPhys, physRectToLogical, physToLogical } from '../actions/coords'
import * as commands from '../agent/commands'
import { getAgent, requireAgent } from '../agent/instance'
import { applyDwellState } from '../agent/sync'
import { onConfigPatched } from '../ipc/settings'
import { flattenElements } from '../query/uia-list'
import * as dwellPalette from '../windows/dwell-palette'
import * as dwellRing from '../windows/dwell-ring'
import * as screenLayer from '../windows/screen-layer'
import { DwellController, dwellSettings, setDwellController, type DwellIo } from './dwell'

const INPUT_TIMEOUT_MS = 10_000
const SNAPSHOT_TIMEOUT_MS = 2500
/** A snapshot older than this is refreshed in the background when the ring is up. */
const NODES_STALE_MS = 3000
const FOCUS_REFRESH_MS = 300

export interface DwellInstallDeps {
  announce: (text: string) => void
  wantFocusEvents: (owner: string, on: boolean) => void
}

async function inputSteps(steps: InputStep[]): Promise<void> {
  await commands.input(requireAgent(), steps, { timeoutMs: INPUT_TIMEOUT_MS })
}

function snapWanted(cfg: AppConfig): boolean {
  return cfg.dwellClick.enabled && (cfg.a11y.dwell.snapToElement || cfg.a11y.dwell.safeTargets)
}

export function installDwell(deps: DwellInstallDeps): DwellController {
  let nodes: ElementNode[] = []
  let nodesAt = 0
  let refreshing = false
  let focusTimer: ReturnType<typeof setTimeout> | null = null

  const refreshNodes = (): void => {
    const agent = getAgent()
    if (refreshing || !agent?.running) return
    refreshing = true
    commands
      .uiaSnapshot(
        agent,
        { scope: 'foreground', maxNodes: 400, interactiveOnly: true },
        { timeoutMs: SNAPSHOT_TIMEOUT_MS }
      )
      .then((snap) => {
        nodes = flattenElements(snap.root).map((f) => f.node)
        nodesAt = Date.now()
      })
      .catch((e: Error) => log('skip', `dwell snap snapshot failed (${e.message})`))
      .finally(() => {
        refreshing = false
      })
  }

  const io: DwellIo = {
    now: () => Date.now(),
    settings: () => dwellSettings(loadConfig()),
    input: inputSteps,
    physToLogical,
    logicalToPhys,
    physRectToLogical,
    displayAt: (p) => {
      const d = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) })
      return {
        bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
        scale: d.scaleFactor
      }
    },
    overPalette: (p) => dwellPalette.contains(p),
    nodes: () => {
      if (Date.now() - nodesAt > NODES_STALE_MS) refreshNodes()
      return nodes
    },
    holdAgent: (paused) => {
      const agent = getAgent()
      if (!agent?.hasCapability('dwell')) return
      agent.request(paused ? 'dwell_pause' : 'dwell_resume').catch(() => {})
    },
    ring: (data) => dwellRing.progress(data),
    overlay: (o) => {
      screenLayer.create()
      screenLayer.setScene({ dwellUi: o.scrollAt || o.dragFrom ? o : undefined })
    },
    paletteState: (s) => dwellPalette.sendState(s),
    announce: deps.announce,
    log: (msg) => log('plan', msg)
  }

  const controller = new DwellController(io)
  setDwellController(controller)
  // A lesson step's target: dwells near it click it (07 T21).
  bus.on('lesson.scene', (e) => controller.setSnapHint(e.scene?.dwellSnap ?? null))

  const syncFocus = (cfg: AppConfig): void => deps.wantFocusEvents('dwell-snap', snapWanted(cfg))
  getAgent()?.onEvent('focus-changed', () => {
    if (!snapWanted(loadConfig())) return
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = setTimeout(() => {
      focusTimer = null
      refreshNodes()
    }, FOCUS_REFRESH_MS)
  })

  // dwellClick changes are applied by settings itself; the a11y.dwell fields are ours.
  onConfigPatched((next, prev) => {
    syncFocus(next)
    const changed =
      JSON.stringify(prev.a11y.dwell) !== JSON.stringify(next.a11y.dwell) &&
      JSON.stringify(prev.dwellClick) === JSON.stringify(next.dwellClick)
    if (changed) applyDwellState(next)
    if (!next.dwellClick.enabled && prev.dwellClick.enabled) controller.reset()
    dwellPalette.sendState(controller.state())
  })
  syncFocus(loadConfig())
  dwellPalette.setVisible(loadConfig().dwellClick.enabled && loadConfig().a11y.dwell.palette)
  dwellPalette.sendState(controller.state())
  return controller
}
