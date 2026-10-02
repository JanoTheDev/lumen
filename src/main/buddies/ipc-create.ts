// Buddy creation wiring (08 T51): the voice creation instance (creation-voice.ts) with the app's
// model, buddies, connectors, skills and folders; "Want a buddy for this?" after finished
// requests; and IPC for Settings: buddies:compose / compose-save ("Make a buddy for me"),
// buddies:export (save dialog) and buddies:import-preview / import (a `.lumen` file, installed
// community-untrusted).
import { createHash, randomBytes } from 'crypto'
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import type {
  Buddy,
  BuddyComposePreview,
  BuddyComposeSaveResult,
  BuddyDraft,
  BuddyImportPreview,
  BuddyImportResult
} from '@shared/buddies'
import {
  buddyComposeSaveSchema,
  buddyComposeSchema,
  buddyExportSchema,
  buddyImportSchema
} from '@shared/ipc'
import { bus } from '../bus'
import { configPath, loadConfig } from '../config'
import { INVALID, safeParse } from '../ipc/validate'
import { log } from '../logger'
import { NoPackError, PackError } from '../packs/install'
import { exportBuddies, installBuddyArchive, planBuddyArchive } from '../packs/buddy-kind'
import { ZIP_LIMITS } from '../packs/zip-read'
import { PRESENT_MS } from '../agent-mode/background/presence'
import { connectorChoices, getSkillRegistry, proposalKey, proposalsMayRecord } from '../skills'
import { resolveFolder } from '../routines'
import { createBuddy, findBuddy, getBuddy, updateBuddy } from './index'
import { authorBuddy, buddyFields, buddyPermissionWords, parseSchedule } from './compose'
import {
  buddyScheduler,
  createBuddyCreation,
  setBuddyCreation,
  type BuddyCreation
} from './creation-voice'
import { modelBuddyEditWords, buddyEditTurn } from './edit'
import { BuddyOfferStore } from './offers'
import { clampPermissions } from './clamp'

const PENDING_MS = 15 * 60_000

const buddiesRoot = (): string => join(dirname(configPath()), 'buddies')

const skillNames = (): string[] => {
  try {
    return (getSkillRegistry()?.enabled() ?? []).map((s) => s.manifest.name).slice(0, 80)
  } catch {
    return []
  }
}

async function composeDraft(description: string): ReturnType<typeof authorBuddy> {
  const known = await connectorChoices()
  return authorBuddy(
    {
      description,
      connectors: known.map((c) => c.id),
      connectorNames: Object.fromEntries(known.map((c) => [c.id, c.name])),
      skills: skillNames()
    },
    { taken: (n) => !!findBuddy(n), resolveFolder }
  )
}

function saveDraft(draft: BuddyDraft): { ok: true; buddy: Buddy } | { ok: false; error: string } {
  try {
    const buddy = createBuddy(buddyFields(draft))
    log('done', `buddy ${buddy.id} created`)
    return { ok: true as const, buddy }
  } catch (e) {
    return { ok: false as const, error: (e as Error).message }
  }
}

function canSpeakUp(): boolean {
  try {
    return (
      !loadConfig().agent.background.quiet && powerMonitor.getSystemIdleTime() * 1000 < PRESENT_MS
    )
  } catch {
    return false
  }
}

/** The app's buddy creation (voice turns, offers). Called once at start. */
export function installBuddyCreation(): BuddyCreation {
  const root = join(homedir(), '.ai-overlay')
  const created = createBuddyCreation({
    now: () => Date.now(),
    log: (msg) => log('plan', msg),
    compose: composeDraft,
    editWords: async (buddy, change) => {
      const known = (await connectorChoices()).map((c) => c.id)
      return modelBuddyEditWords(buddyEditTurn(buddy, change, known))
    },
    connectors: async () => (await connectorChoices()).map((c) => c.id),
    resolveFolder,
    find: (name) => findBuddy(name),
    create: saveDraft,
    update: (id, patch) => updateBuddy(id, patch),
    scheduler: buddyScheduler,
    offers: new BuddyOfferStore(join(root, 'buddy-offers.json'), {
      key: proposalKey(join(root, 'skills-proposals.key')),
      canRecord: proposalsMayRecord
    })
  })
  setBuddyCreation(created)

  // Offers: each finished request the user made (foreground agent task, or their own
  // background task), once per task id.
  const seen = new Set<string>()
  const finished = (id: string, prompt: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    if (seen.size > 500) seen.delete(seen.values().next().value as string)
    // Loaded on use: background/ pulls in the windows.
    void import('../agent-mode/background').then(({ notice }) =>
      created.noteRequest(prompt, { notice, canSpeakUp })
    )
  }
  bus.on('agent.task', (e) => {
    if (e.task?.phase === 'done') finished(e.task.id, e.task.prompt)
  })
  bus.on('task.changed', (e) => {
    const t = e.task
    if (t.phase === 'done' && t.origin === 'voice' && !t.parentId && !t.skill)
      finished(t.id, t.userText ?? t.prompt)
  })
  return created
}

// ---- Settings: compose ----

export async function composeBuddyPreview(description: string): Promise<BuddyComposePreview> {
  const r = await composeDraft(description)
  if (!r.ok) return r
  log('plan', `buddy ${r.draft.name} written for review`)
  return {
    ok: true,
    draft: r.draft,
    permissionsLine: buddyPermissionWords(r.draft.permissions),
    warnings: r.warnings
  }
}

/** Saves a draft from the Settings preview (clamped by the store; the schedule parsed again). */
export async function saveComposedBuddy(
  draft: Omit<BuddyDraft, 'schedule'> & { schedule?: { text: string } }
): Promise<BuddyComposeSaveResult> {
  const sched = draft.schedule
    ? parseSchedule(draft.schedule.text, { now: Date.now(), resolveFolder })
    : null
  const { schedule: _said, ...rest } = draft
  void _said
  const clean: BuddyDraft = {
    ...rest,
    ...(sched && 'schedule' in sched ? { schedule: sched.schedule } : {})
  }
  const r = saveDraft(clean)
  if (!r.ok) return r
  const scheduler = buddyScheduler()
  if (clean.schedule && scheduler)
    await scheduler(r.buddy, clean.schedule).catch((e: Error) =>
      log('fail', `buddy ${r.buddy.id} schedule: ${e.message}`)
    )
  return {
    ok: true,
    id: r.buddy.id,
    name: r.buddy.name,
    // Left for the caller when no scheduler is set (T52 / Settings create the automation).
    ...(clean.schedule && !scheduler ? { schedule: clean.schedule } : {})
  }
}

// ---- export / import ----

const parentOf = (sender?: Electron.WebContents): BrowserWindow | undefined =>
  (sender && BrowserWindow.fromWebContents(sender)) || undefined

export async function exportBuddyFile(
  id: string,
  sender?: Electron.WebContents
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const b = getBuddy(id)
  if (!b) return { ok: false, error: 'no such buddy' }
  const opts: Electron.SaveDialogOptions = {
    title: 'Export buddy',
    defaultPath: join(app.getPath('documents'), `${b.id}.lumen`),
    filters: [{ name: 'Lumen packs', extensions: ['lumen'] }]
  }
  const parent = parentOf(sender)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  const data = exportBuddies([b])
  writeFileSync(pick.filePath, data)
  log('done', `buddy ${b.id} exported (${data.length} bytes)`)
  return { ok: true, path: pick.filePath }
}

const pending = new Map<string, { archive: Buffer; source: string; at: number }>()

/** The buddies in an archive as the import preview shows them. Throws PackError. */
export function previewBuddyArchive(
  archive: Buffer,
  root: string
): Extract<BuddyImportPreview, { ok: true }>['buddies'] {
  return planBuddyArchive(archive, root).map(({ id, buddy: b, updates, notes }) => ({
    id,
    name: b.name,
    look: b.look,
    description: (b.instructions.split('\n')[0] ?? '').slice(0, 160),
    permissions: b.permissions,
    permissionsLine: buddyPermissionWords(b.permissions),
    model: b.model,
    budget: b.budget,
    notes,
    updates
  }))
}

const failure = (e: unknown): { ok: false; error: string; problems?: string[] } =>
  e instanceof NoPackError
    ? { ok: false, error: 'there are no buddies in this file' }
    : e instanceof PackError
      ? { ok: false, error: e.message, ...(e.problems.length ? { problems: e.problems } : {}) }
      : { ok: false, error: (e as Error).message }

export async function previewBuddyFile(sender?: Electron.WebContents): Promise<BuddyImportPreview> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Import a buddy',
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
  const archive = readFileSync(file)
  try {
    const buddies = previewBuddyArchive(archive, buddiesRoot())
    const now = Date.now()
    for (const [k, v] of pending) if (now - v.at > PENDING_MS) pending.delete(k)
    const token = randomBytes(12).toString('hex')
    pending.set(token, { archive, source: basename(file), at: now })
    return { ok: true, token, buddies }
  } catch (e) {
    return failure(e)
  }
}

/** Installs every buddy in the archive as community-untrusted. */
function installArchive(archive: Buffer, source: string, root: string): BuddyImportResult {
  try {
    return { ok: true, installed: installBuddyArchive(archive, source, root) }
  } catch (e) {
    return failure(e)
  }
}

export function importPending(token: string): BuddyImportResult {
  const p = pending.get(token)
  pending.delete(token)
  if (!p || Date.now() - p.at > PENDING_MS)
    return { ok: false, error: 'that import expired; choose the file again' }
  const r = installArchive(p.archive, p.source, buddiesRoot())
  if (!r.ok) {
    log('fail', `buddy import from ${p.source} failed: ${r.error}`)
    return r
  }
  const sha = createHash('sha256').update(p.archive).digest('hex').slice(0, 12)
  for (const b of r.installed) log('done', `buddy ${b.id} imported from ${p.source} (${sha})`)
  bus.emit({ type: 'buddies.changed', ids: r.installed.map((b) => b.id) })
  return r
}

export function registerBuddyCreationIpc(): void {
  installBuddyCreation()
  ipcMain.handle('buddies:compose', (_e, raw: unknown) => {
    const req = safeParse('buddies:compose', buddyComposeSchema, raw)
    return req ? composeBuddyPreview(req.description) : INVALID
  })
  ipcMain.handle('buddies:compose-save', (_e, raw: unknown) => {
    const req = safeParse('buddies:compose-save', buddyComposeSaveSchema, raw)
    return req
      ? saveComposedBuddy({ ...req.draft, permissions: clampPermissions(req.draft.permissions) })
      : INVALID
  })
  ipcMain.handle('buddies:export', (e, raw: unknown) => {
    const req = safeParse('buddies:export', buddyExportSchema, raw)
    return req ? exportBuddyFile(req.id, e.sender) : INVALID
  })
  ipcMain.handle('buddies:import-preview', (e, ...args: unknown[]) =>
    args.length ? INVALID : previewBuddyFile(e.sender)
  )
  ipcMain.handle('buddies:import', (_e, raw: unknown) => {
    const req = safeParse('buddies:import', buddyImportSchema, raw)
    return req ? importPending(req.token) : INVALID
  })
}
