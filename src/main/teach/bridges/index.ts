// App bridges (07 T23–T26): the lesson engine's BridgePort over the Blender add-on and OBS,
// Settings status / setup, and the once-per-app tip when a lesson starts without its bridge.
import { app, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { BridgeId, BridgeStatus } from '@shared/channels'
import { bus } from '../../bus'
import { configPath } from '../../config'
import { log } from '../../logger'
import { announce } from '../../a11y'
import type { BridgePort } from '../ports'
import { BlenderClient, blenderBridge, ensureToken } from './blender'
import { makeBridgePort } from './port'
import { obsBridge, type ObsBridge } from './obs'
import { BridgeSecrets } from './secrets'
import type { AppBridge } from './types'
import { folderEntries, zip } from '../../packs/zip-write'

export const BRIDGE_IDS: readonly BridgeId[] = ['blender', 'obs']

let registry: Map<string, AppBridge> | null = null
let obs: ObsBridge | null = null
let secrets: BridgeSecrets | null = null
let tokenFile = ''

/** Where the add-on folder ships: next to the exe when packaged, the repo in dev. */
function addonSource(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bridges', 'blender', 'lumen_bridge')
    : join(app.getAppPath(), 'bridges', 'blender', 'lumen_bridge')
}

export function addonZipPath(): string {
  return join(app.getPath('userData'), 'bridges', 'lumen_bridge.zip')
}

function bridges(): Map<string, AppBridge> {
  if (registry) return registry
  tokenFile = join(app.getPath('userData'), 'blender-bridge.token')
  secrets = new BridgeSecrets(join(dirname(configPath()), 'bridges.dat'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (t) => safeStorage.encryptString(t),
    decrypt: (b) => safeStorage.decryptString(b)
  })
  const s = secrets
  let token = ''
  const blender = blenderBridge(new BlenderClient(() => (token ||= ensureToken(tokenFile))))
  obs = obsBridge(() => s.obs())
  registry = new Map<string, AppBridge>([
    [blender.id, blender],
    [obs.id, obs]
  ])
  return registry
}

export const bridgePort: BridgePort = makeBridgePort(() => bridges())

/** The app bridge's full state (for challenge checks, 11 T22); null when not connected. */
export async function bridgeState(
  appId: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  const b = bridges().get(appId)
  if (!b) return null
  return ((await b.state({}, signal).catch(() => null)) as Record<string, unknown> | null) ?? null
}

export async function bridgeStatus(id: BridgeId): Promise<BridgeStatus> {
  const b = bridges().get(id)!
  const st = await b.status()
  if (id === 'obs') {
    const o = secrets!.obs()
    return { ...st, port: o.port, hasPassword: !!o.password }
  }
  return { ...st, port: 47651 }
}

export function allBridgeStatus(): Promise<BridgeStatus[]> {
  return Promise.all(BRIDGE_IDS.map(bridgeStatus))
}

export function setObsSettings(s: { password?: string; port?: number }): {
  ok: boolean
  persisted: boolean
} {
  bridges()
  const prev = secrets!.obs()
  const persisted = secrets!.setObs({
    port: s.port ?? prev.port,
    password: s.password === undefined ? prev.password : s.password
  })
  obs!.reset()
  return { ok: true, persisted }
}

export function clearObsSettings(): boolean {
  bridges()
  const ok = secrets!.clearObs()
  obs!.reset()
  return ok
}

/** Packs the add-on into a zip in userData and shows it in Explorer. */
export function revealBlenderAddon(): { ok: boolean; path?: string; error?: string } {
  const src = addonSource()
  if (!existsSync(join(src, '__init__.py'))) return { ok: false, error: 'The add-on is missing.' }
  try {
    bridges()
    ensureToken(tokenFile)
    const out = addonZipPath()
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, zip(folderEntries(src, 'lumen_bridge')))
    shell.showItemInFolder(out)
    return { ok: true, path: out }
  } catch (e) {
    log('fail', `blender add-on zip failed: ${(e as Error).message}`)
    return { ok: false, error: 'Could not write the add-on file.' }
  }
}

// ---- Install offer (T26) ----

const TIPS: Record<string, string> = {
  blender:
    'Tip: a small free Blender add-on lets me check each step exactly. To set it up, open Lumen settings, App helpers.',
  obs: 'Tip: if you turn on OBS’s WebSocket server, I can check each step exactly. To set it up, open Lumen settings, App helpers.'
}

const offeredFile = (): string => join(homedir(), '.ai-overlay', 'teach', 'bridges.json')

function offered(): Record<string, boolean> {
  try {
    const v = JSON.parse(readFileSync(offeredFile(), 'utf8')) as { offered?: unknown }
    return v.offered && typeof v.offered === 'object' ? (v.offered as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/**
 * After the first step of a lesson for a bridge app whose bridge does not answer, says once
 * per app where to set it up. Never installs anything into the app.
 */
export function installBridgeOffer(appOf: (lessonId: string) => string | null): void {
  bus.on('lesson.step-completed', (e) => {
    if (e.step !== 0) return
    const appId = appOf(e.lessonId)
    if (!appId || !TIPS[appId] || offered()[appId]) return
    const b = bridges().get(appId)
    if (!b) return
    void b
      .status()
      .then((st) => {
        if (st.state === 'connected') return
        const all = { ...offered(), [appId]: true }
        mkdirSync(dirname(offeredFile()), { recursive: true })
        writeFileSync(offeredFile(), JSON.stringify({ offered: all }, null, 2))
        announce(TIPS[appId], { kind: 'status', priority: 'polite' })
        log('step', `bridge tip for ${appId} (${st.state})`)
      })
      .catch(() => {})
  })
}
