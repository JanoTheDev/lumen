// Community skill packs (07 T32): install a `.lumen` file (or a GitHub link to one) into
// ~/.ai-overlay/skills as an untrusted community pack, list and remove installed ones, and
// export any pack to a `.lumen` file. The archive handling is generic (src/main/packs); this
// is the Electron side: file dialogs, the app's schema folder and the registry reload.
import { app, BrowserWindow, dialog } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { CommunityPackInfo, PackInstallResult } from '@shared/channels'
import { log } from '../logger'
import { fetchPack, githubPackSource } from '../packs/fetch'
import {
  exportPacks,
  installedPacks,
  installPacks,
  PackError,
  removePack,
  type InstallOptions
} from '../packs/install'
import { skillPackKind } from '../packs/skill-kind'
import { ZIP_LIMITS } from '../packs/zip-read'
import { hasMatchRules, type SkillRegistry } from './registry'

export interface PackDeps {
  registry: () => SkillRegistry | null
  skillsRoot: () => string
}

let deps: PackDeps | null = null

export function installPackSupport(d: PackDeps): void {
  deps = d
}

function kind(): ReturnType<typeof skillPackKind> {
  const reg = deps?.registry()
  return skillPackKind({
    schemaDir: join(app.getAppPath(), 'skills', 'schema'),
    bundledIds: () => (reg?.all() ?? []).filter((s) => s.source === 'builtin').map((s) => s.id),
    knownLessonIds: () => (reg?.all() ?? []).flatMap((s) => s.lessons.map((l) => l.id))
  })
}

function install(
  archive: Buffer,
  source: string,
  extra: Partial<InstallOptions> = {}
): PackInstallResult {
  const root = deps?.skillsRoot()
  const reg = deps?.registry()
  if (!root || !reg) return { ok: false, error: 'lessons are not ready yet' }
  try {
    const done = installPacks(archive, { kind: kind(), destRoot: root, source, ...extra })
    reg.load()
    for (const p of done) log('done', `community pack ${p.id} installed from ${source}`)
    return {
      ok: true,
      installed: done.map((p) => ({
        id: p.id,
        name: reg.get(p.id)?.name ?? p.id,
        updated: p.updated
      }))
    }
  } catch (e) {
    const problems = e instanceof PackError ? e.problems.slice(0, 20) : []
    log('fail', `pack install from ${source} failed: ${(e as Error).message}`)
    return { ok: false, error: (e as Error).message, ...(problems.length ? { problems } : {}) }
  }
}

const parentOf = (sender?: Electron.WebContents): BrowserWindow | undefined =>
  (sender && BrowserWindow.fromWebContents(sender)) || undefined

export async function installPackFromFile(
  sender?: Electron.WebContents
): Promise<PackInstallResult> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Install a lesson pack',
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
    return { ok: false, error: 'the pack is larger than 50 MB' }
  return install(readFileSync(file), basename(file))
}

export async function installPackFromUrl(url: string): Promise<PackInstallResult> {
  let src: ReturnType<typeof githubPackSource>
  try {
    src = githubPackSource(url)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  let archive: Buffer
  try {
    archive = await fetchPack(src.url)
  } catch (e) {
    log('fail', `pack download ${src.label} failed: ${(e as Error).message}`)
    return { ok: false, error: (e as Error).message }
  }
  return install(archive, src.url, src.subpath ? { subpath: src.subpath } : {})
}

export function listCommunityPacks(): CommunityPackInfo[] {
  const root = deps?.skillsRoot()
  const reg = deps?.registry()
  if (!root) return []
  return installedPacks(root, 'skill').map((m) => {
    const skill = reg?.get(m.id)
    return {
      id: m.id,
      name: skill?.name ?? m.id,
      version: skill?.version ?? '',
      lessons: skill?.lessons.length ?? 0,
      source: m.source,
      installedAt: m.installedAt,
      loaded: !!skill && skill.trust === m.trust
    }
  })
}

export function removeCommunityPack(id: string): boolean {
  const root = deps?.skillsRoot()
  if (!root || !removePack(root, id)) return false
  deps?.registry()?.load()
  log('done', `community pack ${id} removed`)
  return true
}

/** Saves a pack (bundled, community or the user's own) as a `.lumen` file. */
export async function exportPack(
  id: string,
  sender?: Electron.WebContents
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const skill = deps?.registry()?.get(id)
  if (!skill?.dir || !hasMatchRules(skill)) return { ok: false, error: 'no such pack' }
  let data: Buffer
  try {
    data = exportPacks([skill.dir], kind())
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const opts: Electron.SaveDialogOptions = {
    title: 'Export lesson pack',
    defaultPath: join(app.getPath('documents'), `${id}.lumen`),
    filters: [{ name: 'Lumen packs', extensions: ['lumen'] }]
  }
  const parent = parentOf(sender)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  writeFileSync(pick.filePath, data)
  log('done', `pack ${id} exported (${data.length} bytes)`)
  return { ok: true, path: pick.filePath }
}
