// Deictic voice wiring (11 T15): mouse-moved is subscribed only while helpers.deictic is on
// (ref-counted with the follow buddy and guide auto-dismiss); recording start / stop come from
// the bus. interceptDeictic() runs ahead of the 06 grammar, so "click this" is not read as a
// control named "this".
import { screen } from 'electron'
import type { Point } from '@shared/types'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'
import { logicalToPhys } from '../actions/coords'
import { executeActions } from '../actions/executor'
import { getAgent } from '../agent/instance'
import { mouseEvents } from '../agent/subscriptions'
import { LOCAL_HANDLED } from '../a11y/dispatch'
import { explainTarget } from '../ai/describe'
import { onConfigPatched } from '../ipc/settings'
import { sharedFiles } from '../files/store'
import { Deictic } from './core'

let deictic: Deictic | null = null
/** "what's that" asks this first (community labels, 11 T13); null = not known. */
let labeler: ((p: Point) => Promise<string | null>) | null = null

export function setDeicticLabeler(fn: ((p: Point) => Promise<string | null>) | null): void {
  labeler = fn
}

const enabled = (): boolean => loadConfig().helpers.deictic

async function explain(p: Point): Promise<string> {
  const known = await labeler?.(p).catch(() => null)
  if (known) return known
  return (await explainTarget({ kind: 'pointer', x: p.x, y: p.y })).spoken
}

export function installDeictic(): void {
  if (deictic) return
  const d = new Deictic({
    now: () => Date.now(),
    enabled,
    cursor: () => logicalToPhys(screen.getCursorScreenPoint()),
    run: async (actions, userText) => {
      const r = await executeActions(actions, {
        origin: 'user-direct',
        userText,
        preview: false,
        refine: false
      })
      if (r.executed > 0 && !r.blocked && !r.cancelled) return { ok: true }
      return { ok: false, why: r.denied ? `I can't do that: ${r.denied.reason}` : undefined }
    },
    explain,
    // Fresh drops always win; older shared files win unless the user just pointed somewhere.
    aboutFiles: (_utterance, pointed) => {
      const files = sharedFiles()
      return files.some((f) => f.fresh) || (files.length > 0 && !pointed)
    },
    log: (msg) => log('plan', msg),
    handled: LOCAL_HANDLED
  })
  deictic = d
  getAgent()?.onEvent('mouse-moved', (data) => {
    const p = data as { x?: unknown; y?: unknown } | undefined
    if (typeof p?.x === 'number' && typeof p.y === 'number' && enabled())
      d.onPointer({ x: p.x, y: p.y })
  })
  bus.on('voice.started', () => d.onVoiceStarted())
  bus.on('voice.stopped', () => d.onVoiceStopped())
  bus.on('voice.cancelled', () => d.onVoiceCancelled())
  const sync = (): void => {
    const on = enabled()
    mouseEvents.want('deictic', on)
    if (!on) d.ring.clear()
  }
  sync()
  onConfigPatched(sync)
}

/** Where the user pointed while saying `utterance` ("this file"), physical px. */
export function pointedAt(utterance: string): Point {
  return deictic?.pointFor(utterance) ?? logicalToPhys(screen.getCursorScreenPoint())
}

/** Voice entry: "click this", "move this there", "what's that" (only with helpers.deictic). */
export function interceptDeictic(prompt: string): unknown | undefined {
  return deictic?.intercept(prompt)
}
