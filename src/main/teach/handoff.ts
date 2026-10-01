// Helper handoff (11 T24, F15), the Electron side: export some of the user's own lessons
// (recorded, saved, imported) plus the community labels of their apps as one `.lumen` file,
// and open such a file from a helper. No server, no account: the file travels by mail, USB or
// chat. Received lessons sit in ~/.ai-overlay/skills/handoff-*/ (marked, untrusted).
import { app, BrowserWindow, dialog } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { HandoffExport, HandoffInfo, HandoffInstallResult } from '@shared/channels'
import { log } from '../logger'
import { labelsChanged, labelStore } from '../labels'
import { parseLabelsFile } from '../labels/store'
import {
  HANDOFF_FILE,
  HANDOFF_KIND,
  handoffId,
  handoffKind,
  parseHandoff,
  type Handoff
} from '../packs/handoff-kind'
import { installedPacks, installPacks, PackError, removePack } from '../packs/install'
import { ZIP_LIMITS } from '../packs/zip-read'
import { zip, type ZipEntry } from '../packs/zip-write'
import { toStoredLesson } from './lesson'
import type { SkillRegistry } from './registry'

export interface HandoffDeps {
  registry(): SkillRegistry | null
  skillsRoot(): string
}

const json = (v: unknown): Buffer => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8')

/** The archive for `req` (pure apart from the label store); throws when there is nothing. */
export function buildHandoff(
  req: HandoffExport,
  reg: SkillRegistry,
  labelsFor: (app: string) => ReturnType<NonNullable<ReturnType<typeof labelStore>>['exportFile']>,
  now = new Date()
): { id: string; data: Buffer; lessons: number; labels: number } {
  const mine = reg.userLessons()
  const picked = mine.filter((x) => req.lessonIds.includes(x.lesson.id))
  const id = handoffId(req.title)
  const entries: ZipEntry[] = []
  for (const { lesson } of picked)
    entries.push({
      name: `${id}/lessons/${lesson.id}.lesson.json`,
      data: json(toStoredLesson(lesson))
    })
  const apps = req.includeLabels ? [...new Set(picked.map((x) => x.lesson.app))] : []
  const labelApps: string[] = []
  for (const a of apps) {
    const file = labelsFor(a)
    if (!file?.labels.length) continue
    labelApps.push(a)
    entries.push({ name: `${id}/labels/${a}.json`, data: json(file) })
  }
  if (!entries.length) throw new Error('pick at least one lesson')
  const meta: Handoff = {
    format: 1,
    id,
    title: req.title.trim().slice(0, 80) || 'Lessons',
    ...(req.from?.trim() ? { from: req.from.trim().slice(0, 60) } : {}),
    ...(req.note?.trim() ? { note: req.note.trim().slice(0, 400) } : {}),
    createdAt: now.toISOString(),
    lessons: picked.map((x) => x.lesson.id),
    labels: labelApps
  }
  entries.unshift({ name: `${id}/${HANDOFF_FILE}`, data: json(parseHandoff(meta)) })
  return { id, data: zip(entries), lessons: picked.length, labels: labelApps.length }
}

/** A labels-only handoff for one app (community labels, 11 T13). */
export function buildLabelsHandoff(
  file: NonNullable<ReturnType<NonNullable<ReturnType<typeof labelStore>>['exportFile']>>,
  now = new Date()
): { id: string; data: Buffer } {
  const id = handoffId(`labels ${file.app}`)
  const meta: Handoff = {
    format: 1,
    id,
    title: `Button names for ${file.appName ?? file.app}`,
    createdAt: now.toISOString(),
    lessons: [],
    labels: [file.app]
  }
  const entries: ZipEntry[] = [
    { name: `${id}/${HANDOFF_FILE}`, data: json(parseHandoff(meta)) },
    { name: `${id}/labels/${file.app}.json`, data: json(file) }
  ]
  return { id, data: zip(entries) }
}

export async function exportLabelsHandoff(
  appId: string,
  sender?: Electron.WebContents
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const file = labelStore()?.exportFile(appId)
  if (!file) return { ok: false, error: 'no labels for that app' }
  const built = buildLabelsHandoff(file)
  const opts: Electron.SaveDialogOptions = {
    title: 'Share button names',
    defaultPath: join(app.getPath('documents'), `${appId}-labels.lumen`),
    filters: [{ name: 'Lumen files', extensions: ['lumen'] }]
  }
  const parent = parentOf(sender)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  writeFileSync(pick.filePath, built.data)
  log('done', `labels for ${appId} exported as ${built.id}`)
  return { ok: true, path: pick.filePath }
}

const parentOf = (sender?: Electron.WebContents): BrowserWindow | undefined =>
  (sender && BrowserWindow.fromWebContents(sender)) || undefined

export async function exportHandoff(
  deps: HandoffDeps,
  req: HandoffExport,
  sender?: Electron.WebContents
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const reg = deps.registry()
  if (!reg) return { ok: false, error: 'lessons are not ready yet' }
  let built: ReturnType<typeof buildHandoff>
  try {
    built = buildHandoff(req, reg, (a) => labelStore()?.exportFile(a) ?? null)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const opts: Electron.SaveDialogOptions = {
    title: 'Share lessons',
    defaultPath: join(app.getPath('documents'), `${built.id.slice('handoff-'.length)}.lumen`),
    filters: [{ name: 'Lumen files', extensions: ['lumen'] }]
  }
  const parent = parentOf(sender)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  writeFileSync(pick.filePath, built.data)
  log(
    'done',
    `handoff ${built.id} exported: ${built.lessons} lessons, labels for ${built.labels} apps`
  )
  return { ok: true, path: pick.filePath }
}

/** Adds the labels of installed handoff folders to this PC's store (never over the user's). */
function importLabels(dir: string, meta: Handoff): number {
  const store = labelStore()
  if (!store) return 0
  let n = 0
  for (const a of meta.labels) {
    try {
      const file = parseLabelsFile(
        JSON.parse(readFileSync(join(dir, 'labels', `${a}.json`), 'utf8'))
      )
      if (file) n += store.put(file.app, file.appName ?? file.app, file.labels, 'shared')
    } catch {
      // validated at install; a missing file just adds nothing
    }
  }
  if (n) labelsChanged()
  return n
}

export function installHandoff(
  deps: HandoffDeps,
  archive: Buffer,
  source: string
): HandoffInstallResult {
  const root = deps.skillsRoot()
  const reg = deps.registry()
  if (!root || !reg) return { ok: false, error: 'lessons are not ready yet' }
  try {
    const done = installPacks(archive, { kind: handoffKind(), destRoot: root, source })
    reg.load()
    const installed = done.map((p) => {
      const meta = parseHandoff(JSON.parse(readFileSync(join(p.dir, HANDOFF_FILE), 'utf8')))
      const labels = importLabels(p.dir, meta)
      log(
        'done',
        `handoff ${p.id} installed from ${source}: ${meta.lessons.length} lessons, ${labels} labels`
      )
      return {
        id: p.id,
        title: meta.title,
        ...(meta.from ? { from: meta.from } : {}),
        lessons: meta.lessons.length,
        labels,
        updated: p.updated
      }
    })
    return { ok: true, installed }
  } catch (e) {
    const problems = e instanceof PackError ? e.problems.slice(0, 20) : []
    log('fail', `handoff install from ${source} failed: ${(e as Error).message}`)
    return { ok: false, error: (e as Error).message, ...(problems.length ? { problems } : {}) }
  }
}

export async function installHandoffFromFile(
  deps: HandoffDeps,
  sender?: Electron.WebContents
): Promise<HandoffInstallResult> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Open lessons from a helper',
    filters: [{ name: 'Lumen files', extensions: ['lumen', 'zip'] }],
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
  return installHandoff(deps, readFileSync(file), basename(file))
}

export function listHandoffs(deps: HandoffDeps): HandoffInfo[] {
  const root = deps.skillsRoot()
  if (!root) return []
  return installedPacks(root, HANDOFF_KIND).flatMap((m) => {
    try {
      const meta = parseHandoff(JSON.parse(readFileSync(join(m.dir, HANDOFF_FILE), 'utf8')))
      return [
        {
          id: m.id,
          title: meta.title,
          ...(meta.from ? { from: meta.from } : {}),
          ...(meta.note ? { note: meta.note } : {}),
          lessons: meta.lessons.length,
          installedAt: m.installedAt
        }
      ]
    } catch {
      return []
    }
  })
}

export function removeHandoff(deps: HandoffDeps, id: string): boolean {
  const root = deps.skillsRoot()
  if (!root || !removePack(root, id, HANDOFF_KIND)) return false
  deps.registry()?.load()
  log('done', `handoff ${id} removed`)
  return true
}
