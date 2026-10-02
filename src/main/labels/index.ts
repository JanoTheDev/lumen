// Community accessibility labels wiring (11 T13). "label the buttons" names the unnamed
// controls of the foreground window with the vision model (only on request: the crops are
// sent then, nothing else). Saved labels are then used by focus narration, "what's this" /
// "what's that" and "click <label>" (06 grammar), while helpers.labels is on. App packs may
// ship a labels.json (read-only); `.lumen` files from helpers add theirs to this PC's store.
import { app as electronApp, BrowserWindow, dialog, screen } from 'electron'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ElementNode, Point } from '@shared/types'
import { loadConfig } from '../config'
import { log } from '../logger'
import { logicalToPhys } from '../actions/coords'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { setUnnamedLabeler } from '../a11y'
import { cropImage, decodeGray } from '../ai/frames'
import { getProvider, hasVisionModel } from '../ai/providers'
import { setDeicticLabeler } from '../deictic'
import { skillRegistry } from '../teach'
import { appIdFor } from '../teach/generate'
import { saveChosenFile } from '../teach/save-file'
import { createLabeler, type LabelApp, type Labeler, type LabelResult } from './core'
import { isGenericName } from './detect'
import { parseLabelCommand } from './grammar'
import { labelReplySchema } from './prompt'
import { LabelStore, parseLabelsFile, type LabelEntry } from './store'
import { withUsageFeature } from '../usage/scope'

const AGENT_TIMEOUT_MS = 3000
const LABEL_TIMEOUT_MS = 30_000
/** How often the foreground app is checked while labels are in use. */
const APP_POLL_MS = 4000

let store: LabelStore | null = null
let labeler: Labeler | null = null
let current: LabelApp | null = null
const packCache = new Map<string, { mtime: number; labels: LabelEntry[] }>()

export function labelStore(): LabelStore | null {
  return store
}

/** labels.json of the app's pack (bundled or installed), read-only. */
function packLabels(appId: string): LabelEntry[] {
  const dir = skillRegistry()?.get(appId)?.dir
  if (!dir) return []
  const file = join(dir, 'labels.json')
  try {
    const mtime = statSync(file).mtimeMs
    const hit = packCache.get(file)
    if (hit?.mtime === mtime) return hit.labels
    const parsed = parseLabelsFile(JSON.parse(readFileSync(file, 'utf8')))
    const labels = parsed?.app === appId ? parsed.labels : []
    if (!parsed) log('fail', `labels: ${file} is not a valid labels file`)
    packCache.set(file, { mtime, labels })
    return labels
  } catch {
    return []
  }
}

function appOf(w: { title: string; process?: string }): LabelApp | null {
  const skill = skillRegistry()?.matchApp({ process: w.process, title: w.title })
  if (skill) return { id: skill.id, name: skill.name }
  if (!w.process) return null
  const id = appIdFor(null, w.process)
  const name = (w.process.split(/[\\/]/).pop() ?? id).replace(/\.exe$/i, '')
  return { id, name }
}

async function activeWindow(): Promise<commands.ActiveWindowInfo | null> {
  const agent = getAgent()
  if (!agent) return null
  return commands.activeWindow(agent, { timeoutMs: AGENT_TIMEOUT_MS }).catch(() => null)
}

function makeLabeler(s: LabelStore): Labeler {
  return createLabeler({
    window: async () => {
      const w = await activeWindow()
      if (!w) return null
      const out = { title: w.title, rect: w.rect, process: w.process || w.exe }
      current = appOf(out)
      return out
    },
    appOf,
    snapshot: async () => {
      const agent = getAgent()
      if (!agent) return null
      const r = await commands
        .uiaSnapshot(
          agent,
          { scope: 'foreground', maxNodes: 1200 },
          { timeoutMs: AGENT_TIMEOUT_MS }
        )
        .catch(() => null)
      return r?.root ?? null
    },
    capture: async (region) => {
      const agent = getAgent()
      if (!agent || region.w <= 0 || region.h <= 0) return null
      const r = await commands
        .capture(
          agent,
          { region, maxWidth: Math.min(2560, Math.round(region.w)), quality: 85 },
          { timeoutMs: AGENT_TIMEOUT_MS }
        )
        .catch(() => null)
      const f = r?.frames[0]
      return f ? { data: f.data, width: f.width, region: f.region ?? region } : null
    },
    crop: cropImage,
    gray: (b64) => decodeGray(b64, 36),
    hasModel: hasVisionModel,
    complete: async (system, user, images) => {
      const { llm, model, effort } = getProvider('fast')
      const res = await withUsageFeature('label', () =>
        llm.complete(
          {
            model,
            system: [{ text: system, cacheable: true }],
            messages: [{ role: 'user', content: user }],
            images: images.map((base64) => ({
              base64,
              mediaType: 'image/jpeg' as const,
              detail: 'low' as const
            })),
            maxTokens: 1500,
            effort,
            schema: labelReplySchema,
            schemaName: 'lumen_control_labels'
          },
          AbortSignal.timeout(LABEL_TIMEOUT_MS)
        )
      )
      log('plan', `labels: vision call (${res.model})`)
      return res.data
    },
    store: s,
    log: (msg) => log('plan', msg)
  })
}

const enabled = (): boolean => loadConfig().helpers.labels

let anyCache: { at: number; yes: boolean } | null = null
/** Labels on this PC or in any pack (checked once a minute). */
function anyLabels(): boolean {
  const now = Date.now()
  if (anyCache && now - anyCache.at < 60_000) return anyCache.yes
  const yes =
    !!store?.apps().length ||
    (skillRegistry()?.all() ?? []).some((s) => !!s.dir && existsSync(join(s.dir, 'labels.json')))
  anyCache = { at: now, yes }
  return yes
}

/** Labels were added or removed: look again. */
export function labelsChanged(): void {
  anyCache = null
}

/** Focus narration and "click <label>": the saved label of an unnamed control (sync). */
function syncLabel(el: { name?: string; role?: string; automationId?: string }): string | null {
  if (!store || !current || !enabled()) return null
  if (!el.role || !el.automationId || (el.name && !isGenericName(el.name, el.role))) return null
  return store.find(current.id, { role: el.role, automationId: el.automationId })?.label ?? null
}

function labelNodes(nodes: ElementNode[]): ElementNode[] {
  if (!store || !current || !enabled() || !store.has(current.id)) return nodes
  return nodes.map((n) => {
    const label = syncLabel(n)
    return label ? { ...n, name: label } : n
  })
}

function resultText(r: LabelResult): string {
  if (r.ok) {
    const rest = r.asked - r.named
    return `Named ${r.named} ${r.named === 1 ? 'control' : 'controls'} in ${r.app.name}${rest ? `; I could not tell what ${rest} of them do` : ''}. Say “what's this” with the pointer on one, or “click” and its name. You can check the names in Settings, Smart helpers.`
  }
  switch (r.reason) {
    case 'no-window':
      return 'I could not find the window to label.'
    case 'no-model':
      return 'Naming controls needs an AI key or a local vision model. Add one in Settings, Models.'
    case 'none':
      return `I found no unnamed buttons in ${r.app?.name ?? 'this window'}.`
    case 'all-known':
      return `The unnamed controls here already have labels (${r.known}).`
    case 'failed':
      return 'Naming the controls did not work this time.'
  }
}

const cursor = (): Point => logicalToPhys(screen.getCursorScreenPoint())

/** Voice: "label the buttons", "name this Render". */
export function interceptLabels(prompt: string): unknown | undefined {
  // Smart helpers → labels off: these words are ordinary requests for the model.
  if (!enabled()) return undefined
  const cmd = labeler && parseLabelCommand(prompt)
  if (!cmd || !labeler) return undefined
  if (cmd.kind === 'label-window')
    return labeler
      .labelWindow()
      .then((r) => {
        labelsChanged()
        return { mode: 'answer', text: resultText(r) }
      })
      .catch(() => ({ mode: 'answer', text: 'Naming the controls did not work this time.' }))
  return labeler.nameAt(cursor(), cmd.label).then((r) => {
    labelsChanged()
    return {
      mode: 'answer',
      text: r.ok
        ? `Saved. This is now called ${cmd.label}${r.app ? ` in ${r.app.name}` : ''}.`
        : (r.why ?? 'Not saved.')
    }
  })
}

/** Saves the app's labels as a pack labels.json (for an app pack or a pull request). */
export async function saveLabelsJson(
  appId: string,
  sender?: Electron.WebContents
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const data = store?.exportFile(appId)
  if (!data) return { ok: false, error: 'no labels for that app' }
  const opts: Electron.SaveDialogOptions = {
    title: 'Save labels.json',
    defaultPath: join(electronApp.getPath('documents'), `${appId}-labels.json`),
    filters: [{ name: 'Labels', extensions: ['json'] }]
  }
  const parent = (sender && BrowserWindow.fromWebContents(sender)) || undefined
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  const saved = saveChosenFile(pick.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  if (saved.ok) log('done', `labels for ${appId} saved (${data.labels.length})`)
  return saved
}

/** Call once at startup, after teach (the pack registry) and a11y. */
export function installLabels(): void {
  if (store) return
  const s = new LabelStore(join(homedir(), '.ai-overlay', 'labels'), packLabels)
  store = s
  labeler = makeLabeler(s)
  const at = (p: Point): Promise<string | null> =>
    enabled() && labeler && anyLabels() ? labeler.labelAt(p) : Promise.resolve(null)
  setUnnamedLabeler({ name: syncLabel, nodes: labelNodes, at })
  setDeicticLabeler(at)
  // The foreground app, for the sync lookups above; only while there are labels to use.
  setInterval(() => {
    if (!enabled() || !anyLabels()) return
    void activeWindow().then((w) => {
      current = w ? appOf({ title: w.title, process: w.process || w.exe }) : null
    })
  }, APP_POLL_MS).unref?.()
}
