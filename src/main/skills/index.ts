// Skills (plans 11, CONTRACTS C10): the Electron side. Builds the registry over the app's
// skills/builtin, its bundled app packs and ~/.ai-overlay/skills, watches the user folder,
// and serves Settings → Skills (file dialogs, GitHub links, the two-step install with a
// permissions screen). The pure parts live next to it: registry, disclosure (L1/L2/L3 tools),
// triggers, manage, kind.
import { app, BrowserWindow, dialog } from 'electron'
import { randomBytes } from 'crypto'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type {
  PackInstallResult,
  SkillActionResult,
  SkillComposePreview,
  SkillDetail,
  SkillInstallPreview
} from '@shared/channels'
import type { SkillRunRecord, SkillSummary } from '@shared/types'
import { log } from '../logger'
import { fetchPack, githubPackSource } from '../packs/fetch'
import { ZIP_LIMITS } from '../packs/zip-read'
import { authorSkill, validateDraftFiles, type AuthoredSkill } from './compose'
import { skillFiles, skillIndexText, type SkillIndexContext } from './disclosure'
import {
  createSkill,
  deleteSkill,
  exportSkill,
  installArchive,
  previewArchive,
  saveSkillText,
  writeNewSkill
} from './manage'
import { SKILL_FILE, parseSkillFile } from './manifest'
import { SkillRegistry, readSkillText } from './registry'
import { needsUpdate } from './health'
import { SkillRunLog } from './runs'
import { SkillStateStore } from './state'
import {
  MAX_STEPS_FILE_BYTES,
  STEPS_FILE,
  StepsFileError,
  parseStepsFile,
  type StepsFile
} from './steps'
import { matchSkillTrigger, type TriggerContext, type TriggerMatch } from './triggers'

let registry: SkillRegistry | null = null
let state: SkillStateStore | null = null
let runs: SkillRunLog | null = null

/** Loads every skill and starts watching the user folder. Safe to call twice. */
export function installSkills(): SkillRegistry {
  if (registry) return registry
  const base = join(homedir(), '.ai-overlay')
  const appSkills = join(app.getAppPath(), 'skills')
  state = new SkillStateStore(join(base, 'skills-state.json'))
  runs = new SkillRunLog(join(base, 'skills-runs.json'))
  registry = new SkillRegistry(
    { builtin: join(appSkills, 'builtin'), appPacks: appSkills, user: join(base, 'skills') },
    { state, log: (m) => log('fail', m) }
  ).load()
  log('plan', `skills: ${registry.all().length} loaded, ${registry.enabled().length} enabled`)
  registry.watch()
  app.on('before-quit', () => registry?.unwatch())
  return registry
}

export function getSkillRegistry(): SkillRegistry | null {
  return registry
}

/** L1 for the cached system prefix ("" when no skill is enabled or skills are not loaded). */
export function skillIndex(ctx?: SkillIndexContext): string {
  return registry ? skillIndexText(registry, ctx) : ''
}

/** Trigger phrase → skill, locally (no model call). */
export function matchTrigger(text: string, ctx?: TriggerContext): TriggerMatch | null {
  return registry ? matchSkillTrigger(text, registry, ctx) : null
}

/** A skill's steps.json, parsed; null when it has none. Throws StepsFileError when broken. */
export function loadSkillSteps(name: string): StepsFile | null {
  const s = registry?.get(name)
  if (!s?.hasSteps) return null
  const file = join(s.dir, STEPS_FILE)
  if (statSync(file).size > MAX_STEPS_FILE_BYTES)
    throw new StepsFileError('steps.json is too large')
  return parseStepsFile(readFileSync(file, 'utf8'))
}

type SkillRunListener = (name: string, run: SkillRunRecord) => void
const runListeners: SkillRunListener[] = []

/** Called after each recorded run (skill health, the run behind an update). */
export function onSkillRun(fn: SkillRunListener): void {
  runListeners.push(fn)
}

/** One finished run (foreground or background) for the skill's history. */
export function recordSkillRun(name: string, run: SkillRunRecord): void {
  runs?.add(name, run)
  for (const fn of runListeners) {
    try {
      fn(name, run)
    } catch (e) {
      log('fail', `skill run listener: ${(e as Error).message}`)
    }
  }
}

export function skillRuns(name: string): SkillRunRecord[] {
  return runs?.list(name) ?? []
}

// ---- Settings ----

export function listSkillSummaries(): SkillSummary[] {
  if (!registry) return []
  return registry.all().map((s) => {
    const summary = registry!.summary(s)
    return needsUpdate(skillRuns(summary.name)) ? { ...summary, needsUpdate: true } : summary
  })
}

export function skillDetail(name: string): SkillDetail | { ok: false; error: string } {
  const s = registry?.get(name)
  if (!registry || !s) return { ok: false, error: 'no such skill' }
  try {
    return {
      ok: true,
      summary: registry.summary(s),
      text: readSkillText(join(s.dir, SKILL_FILE)),
      files: skillFiles(s.dir)
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function setSkillEnabled(name: string, enabled: boolean): boolean {
  if (!registry?.get(name) || !state) return false
  state.setEnabled(name, enabled)
  log('done', `skill ${name} ${enabled ? 'enabled' : 'disabled'}`)
  return true
}

export function setSkillTrusted(name: string, trusted: boolean): boolean {
  const s = registry?.get(name)
  if (!s || !state || s.baseTrust !== 'community-untrusted') return false
  state.setTrusted(name, trusted, s.pin)
  log('done', `skill ${name} ${trusted ? 'trusted' : 'untrusted'}`)
  return true
}

const notReady = { ok: false as const, error: 'skills are not ready yet' }

export function saveSkill(name: string, text: string): SkillActionResult {
  if (!registry) return notReady
  const r = saveSkillText(registry, name, text)
  if (r.ok) log('done', `skill ${name} saved`)
  return r
}

export function newSkill(name: string, description: string): SkillActionResult {
  if (!registry) return notReady
  const r = createSkill(registry, name, description)
  return r.ok ? { ok: true } : r
}

export function removeSkill(name: string): SkillActionResult {
  if (!registry) return notReady
  const r = deleteSkill(registry, name)
  if (r.ok) {
    state?.forget(name)
    runs?.forget(name)
    log('done', `skill ${name} deleted`)
  }
  return r
}

// ---- "Write it for me" (11 F9) ----

/** The connectors set up in Settings (id + name), for skills the model writes or edits. */
export async function connectorChoices(): Promise<{ id: string; name: string }[]> {
  try {
    // Loaded on use: the connectors module pulls in the policy gate and its windows.
    const { connectors } = await import('../connectors')
    return connectors()
      .list()
      .slice(0, 40)
      .map((c) => ({ id: c.id, name: c.name }))
  } catch {
    return []
  }
}

const composed = new Map<string, { skill: AuthoredSkill; at: number }>()

/** The model writes a skill from a description; kept for review under a token. */
export async function composeSkillDraft(description: string): Promise<SkillComposePreview> {
  if (!registry) return notReady
  const reg = registry
  const known = await connectorChoices()
  const r = await authorSkill(
    {
      description,
      apps: [...new Set(reg.all().flatMap((s) => s.manifest.apps))].slice(0, 60),
      connectors: known.map((c) => c.id),
      connectorNames: Object.fromEntries(known.map((c) => [c.id, c.name]))
    },
    { taken: (n) => !!reg.get(n) }
  )
  if (!r.ok) return r
  const now = Date.now()
  for (const [k, v] of composed) if (now - v.at > PENDING_MS) composed.delete(k)
  const token = randomBytes(12).toString('hex')
  composed.set(token, { skill: r, at: now })
  const { manifest } = parseSkillFile(r.files.skillMd)
  log('plan', `skill ${r.draft.name} written for review`)
  return {
    ok: true,
    token,
    name: r.draft.name,
    text: r.files.skillMd,
    permissions: manifest.permissions,
    apps: manifest.apps,
    triggers: manifest.triggers,
    hasSteps: !!r.files.stepsJson,
    files: [
      ...(r.files.stepsJson ? [STEPS_FILE] : []),
      ...(r.files.extra ?? []).map((f) => f.path)
    ],
    warnings: r.warnings
  }
}

/** Saves a reviewed skill: the SKILL.md as the user left it, plus its other files. */
export function saveComposedSkill(
  token: string,
  text: string
): { ok: true; name: string } | { ok: false; error: string; problems?: string[] } {
  const c = composed.get(token)
  if (!c || Date.now() - c.at > PENDING_MS)
    return { ok: false, error: 'that draft expired; write it again' }
  if (!registry) return notReady
  const files = { ...c.skill.files, skillMd: text.replace(/\r\n?/g, '\n') }
  let name: string
  try {
    validateDraftFiles(files)
    name = parseSkillFile(files.skillMd).manifest.name
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const r = writeNewSkill(registry, name, files)
  if (!r.ok) return r
  composed.delete(token)
  log('done', `skill ${name} saved from a written draft`)
  return { ok: true, name }
}

// ---- install / share ----

interface Pending {
  archive: Buffer
  source: string
  subpath?: string
  at: number
}
const pending = new Map<string, Pending>()
const PENDING_MS = 10 * 60_000

function remember(p: Omit<Pending, 'at'>): string {
  const now = Date.now()
  for (const [k, v] of pending) if (now - v.at > PENDING_MS) pending.delete(k)
  const token = randomBytes(12).toString('hex')
  pending.set(token, { ...p, at: now })
  return token
}

function preview(p: Omit<Pending, 'at'>): SkillInstallPreview {
  if (!registry) return notReady
  const r = previewArchive(registry, p.archive, p.subpath, p.source)
  if (!r.ok) {
    log('fail', `skill install from ${p.source}: ${r.error}`)
    return r
  }
  return { ok: true, token: remember(p), source: p.source, skills: r.skills }
}

const parentOf = (sender?: Electron.WebContents): BrowserWindow | undefined =>
  (sender && BrowserWindow.fromWebContents(sender)) || undefined

export async function previewSkillFile(
  sender?: Electron.WebContents
): Promise<SkillInstallPreview> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Install a skill',
    filters: [{ name: 'Lumen packs', extensions: ['lumen', 'zip'] }],
    properties: ['openFile']
  }
  const parent = parentOf(sender)
  const pick = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  const file = pick.filePaths[0]
  if (pick.canceled || !file) return { ok: false, error: 'cancelled' }
  if (statSync(file).size > ZIP_LIMITS.maxBytes)
    return { ok: false, error: 'the file is larger than 50 MB' }
  return preview({ archive: readFileSync(file), source: basename(file) })
}

export async function previewSkillUrl(url: string): Promise<SkillInstallPreview> {
  let src: ReturnType<typeof githubPackSource>
  try {
    src = githubPackSource(url)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  try {
    const archive = await fetchPack(src.url)
    return preview({ archive, source: src.url, ...(src.subpath ? { subpath: src.subpath } : {}) })
  } catch (e) {
    log('fail', `skill download ${src.label} failed: ${(e as Error).message}`)
    return { ok: false, error: (e as Error).message }
  }
}

export function installPending(token: string): PackInstallResult {
  const p = pending.get(token)
  pending.delete(token)
  if (!p || Date.now() - p.at > PENDING_MS)
    return { ok: false, error: 'that install expired; choose the file again' }
  if (!registry) return notReady
  const r = installArchive(registry, p.archive, p.source, p.subpath)
  if (!r.ok) {
    log('fail', `skill install from ${p.source} failed: ${r.error}`)
    return r
  }
  for (const s of r.installed) log('done', `skill ${s.id} installed from ${p.source}`)
  return {
    ok: true,
    installed: r.installed.map((s) => ({ id: s.id, name: s.id, updated: s.updated }))
  }
}

export function cancelPending(token: string): boolean {
  return pending.delete(token)
}

export async function exportSkillFile(
  name: string,
  sender?: Electron.WebContents
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!registry) return notReady
  const r = exportSkill(registry, name)
  if (!r.ok) return r
  const opts: Electron.SaveDialogOptions = {
    title: 'Export skill',
    defaultPath: join(app.getPath('documents'), `${name}.lumen`),
    filters: [{ name: 'Lumen packs', extensions: ['lumen'] }]
  }
  const parent = parentOf(sender)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  writeFileSync(pick.filePath, r.data)
  log('done', `skill ${name} exported (${r.data.length} bytes)`)
  return { ok: true, path: pick.filePath }
}
