// Settings → Memory: overview, profile/app/working fact edits, the review queue, episodes
// (list, search, delete), export as a zip, delete-all with a typed confirm, open folder.
// On/off, auto-learn, retention and private mode are plain config fields (settings:patch).
import { app, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type {
  MemoryEpisodeView,
  MemoryFactOp,
  MemoryFactView,
  MemoryOverview,
  MemoryResult
} from '@shared/channels'
import { INVALID, safeParse } from './validate'
import { patchConfig } from './settings'
import { loadConfig } from '../config'
import { log } from '../logger'
import { broadcast } from '../windows/registry'
import { memory, onSessionEnd, setMemory } from '../ai/memory/runtime'
import type { Episode, Fact } from '../ai/memory'
import { setMemoryHooks } from '../query/memory-commands'

export const DELETE_CONFIRM_WORD = 'DELETE'
const MAX_EPISODES = 200

const layer = z.enum(['profile', 'app', 'working'])
const text = z.string().trim().min(1).max(300)
const factOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    layer,
    app: z.string().max(80).optional(),
    text,
    section: z.string().max(40).optional()
  }),
  z.object({
    op: z.literal('update'),
    layer,
    app: z.string().max(80).optional(),
    old: text,
    text,
    section: z.string().max(40).optional()
  }),
  z.object({ op: z.literal('remove'), layer, app: z.string().max(80).optional(), text })
])
const reviewSchema = z.object({ id: z.string().min(1).max(80), accept: z.boolean() })
const querySchema = z.string().max(200).optional()
const idSchema = z.string().min(1).max(80)
const confirmSchema = z.string().max(40)

const factView = (f: Fact): MemoryFactView => ({
  section: f.section,
  text: f.text,
  ...(f.date ? { date: f.date } : {}),
  source: f.source
})

const episodeView = (e: Episode): MemoryEpisodeView => ({ ...e })

export function memoryOverview(): MemoryOverview {
  const mem = memory()
  const s = loadConfig().memory
  return {
    enabled: s.enabled,
    autoLearn: s.autoLearn,
    privateMode: s.privateMode,
    retentionDays: s.retentionDays,
    dir: mem.store.dir,
    profile: mem.profile.facts().map(factView),
    working: mem.working.facts().map(factView),
    apps: mem.apps
      .ids()
      .map((id) => ({ id, facts: mem.apps.facts(id).map(factView) }))
      .filter((a) => a.facts.length),
    pending: mem.pending().map((p) => ({
      id: p.id,
      layer: p.layer,
      ...(p.appId ? { appId: p.appId } : {}),
      fact: p.fact,
      confidence: p.confidence,
      createdAt: p.createdAt
    })),
    episodeCount: mem.episodes.list().length
  }
}

/** Edits from the profile editor. Explicit user edits work in private mode, not with memory off. */
export function applyFactOp(op: MemoryFactOp): MemoryResult {
  if (!loadConfig().memory.enabled) return { ok: false, error: 'Memory is off.' }
  const mem = memory()
  if (op.layer === 'app' && !op.app) return { ok: false, error: 'Which app?' }
  if (op.op === 'remove') {
    const same = (f: Fact): boolean => f.text === op.text
    const removed =
      op.layer === 'profile'
        ? mem.profile.file.remove(same)
        : op.layer === 'working'
          ? mem.working.file.remove(same)
          : mem.apps.remove(op.app!, same)
    return removed.length ? { ok: true } : { ok: false, error: 'Not found.' }
  }
  const replaces = op.op === 'update' ? op.old : undefined
  const r =
    op.layer === 'profile'
      ? mem.profile.add({ text: op.text, section: op.section, source: 'said', replaces })
      : op.layer === 'working'
        ? mem.working.add(op.text, replaces)
        : mem.apps.add(op.app!, { text: op.text, section: op.section, source: 'said', replaces })
  // An update whose subject differs from the old line still has to drop the old one.
  if (op.op === 'update' && r !== 'rejected' && op.old !== op.text) {
    const old = (f: Fact): boolean => f.text === op.old
    if (op.layer === 'profile') mem.profile.file.remove(old)
    else if (op.layer === 'working') mem.working.file.remove(old)
    else mem.apps.remove(op.app!, old)
  }
  return r === 'rejected'
    ? { ok: false, error: "That looks like something private I shouldn't store." }
    : { ok: true }
}

export function reviewProposal(id: string, accept: boolean): MemoryResult {
  const mem = memory()
  if (!accept) return mem.rejectPending(id) ? { ok: true } : { ok: false, error: 'Not found.' }
  const r = mem.acceptPending(id)
  if (r === null) return { ok: false, error: 'Not found.' }
  if (r === 'disabled') return { ok: false, error: 'Memory is off or in private mode.' }
  if (r === 'rejected') return { ok: false, error: 'That fact could not be stored.' }
  return { ok: true }
}

export function listEpisodes(query?: string): MemoryEpisodeView[] {
  const mem = memory()
  const q = query?.trim()
  if (!q) return mem.episodes.list().slice(0, MAX_EPISODES).map(episodeView)
  return mem.searchEpisodes(q, undefined, 50).map((r) => episodeView(r.episode))
}

/** Removes every memory file. The next use starts from an empty folder. */
export function deleteAllMemory(confirm: string): MemoryResult {
  if (confirm.trim() !== DELETE_CONFIRM_WORD)
    return { ok: false, error: `Type ${DELETE_CONFIRM_WORD} to confirm.` }
  const dir = memory().store.dir
  rmSync(dir, { recursive: true, force: true })
  setMemory(null)
  log('done', `[memory] deleted all memory in ${dir}`)
  return { ok: true }
}

function zip(dir: string, out: string): Promise<void> {
  // Windows 10+ tar.exe (bsdtar) writes a zip when the name ends in .zip.
  return new Promise((resolve, reject) =>
    execFile('tar', ['-a', '-c', '-f', out, '-C', dir, '.'], (err) =>
      err ? reject(err) : resolve()
    )
  )
}

export async function exportMemory(destDir: string): Promise<MemoryResult & { path?: string }> {
  const dir = memory().store.dir
  if (!existsSync(dir)) return { ok: false, error: 'Nothing saved yet.' }
  mkdirSync(destDir, { recursive: true })
  const out = join(destDir, `lumen-memory-${new Date().toISOString().slice(0, 10)}.zip`)
  try {
    rmSync(out, { force: true })
    await zip(dir, out)
    return { ok: true, path: out }
  } catch (e) {
    log('fail', `memory export failed: ${(e as Error).message}`)
    return { ok: false, error: 'Export failed.' }
  }
}

function changed(): void {
  try {
    broadcast('memory:changed', { pending: memory().pending().length })
  } catch {
    // windows not up yet
  }
}

export function registerMemoryIpc(): void {
  setMemoryHooks({ patchConfig, changed })
  onSessionEnd((r) => {
    if (r.status === 'saved') changed()
  })

  ipcMain.handle('memory:get', () => memoryOverview())
  ipcMain.handle('memory:fact', (_e, raw: unknown) => {
    const op = safeParse('memory:fact', factOpSchema, raw)
    if (!op) return INVALID
    const r = applyFactOp(op)
    if (r.ok) changed()
    return r
  })
  ipcMain.handle('memory:review', (_e, raw: unknown) => {
    const req = safeParse('memory:review', reviewSchema, raw)
    if (!req) return INVALID
    const r = reviewProposal(req.id, req.accept)
    changed()
    return r
  })
  ipcMain.handle('memory:episodes', (_e, raw: unknown) => {
    const q = safeParse('memory:episodes', querySchema, raw)
    return listEpisodes(q)
  })
  ipcMain.handle('memory:episode-delete', (_e, raw: unknown) => {
    const id = safeParse('memory:episode-delete', idSchema, raw)
    if (!id) return INVALID
    const ok = memory().deleteEpisode(id)
    if (ok) changed()
    return { ok }
  })
  ipcMain.handle('memory:export', async () => {
    const r = await exportMemory(app.getPath('downloads'))
    if (r.path) shell.showItemInFolder(r.path)
    return r
  })
  ipcMain.handle('memory:delete-all', (_e, raw: unknown) => {
    const confirm = safeParse('memory:delete-all', confirmSchema, raw)
    if (confirm === undefined) return INVALID
    const r = deleteAllMemory(confirm)
    if (r.ok) changed()
    return r
  })
  ipcMain.on('memory:open-folder', () => {
    const dir = memory().store.dir
    mkdirSync(dir, { recursive: true })
    shell.openPath(dir).catch(() => {})
  })
}
