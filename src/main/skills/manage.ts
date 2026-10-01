// Skill files on disk (11 T05/T06): install previews (the permissions screen), install, export,
// create, edit and delete. Installs go through the generic `.lumen` installer (src/main/packs)
// with the agent-skill PackKind, so the zip checks, staging and markers are shared with lesson
// packs. Only the user folder is ever written; builtin and app-pack skills are copied there to
// be edited (the copy overrides them). No Electron.
import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { SkillPreviewInfo } from '@shared/channels'
import {
  exportPacks,
  installPacks,
  NoPackError,
  PackError,
  planPacks,
  removePack,
  MARKER_FILE,
  packMarker,
  type InstalledPack,
  type PackMarker
} from '../packs/install'
import { readZip, ZIP_LIMITS } from '../packs/zip-read'
import { agentSkillKind } from './kind'
import { SKILL_FILE, SKILL_NAME_RE, parseSkillFile, skillTemplate } from './manifest'
import { RESERVED_DIRS, SKILL_PACK_KIND, appPackIds, type SkillRegistry } from './registry'
import { trustPin } from './state'
import { STEPS_FILE, parseStepsFile } from './steps'

export type SkillPreview = SkillPreviewInfo

export type Result<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; problems?: string[] }

const failure = (e: unknown): { ok: false; error: string; problems?: string[] } => {
  const problems = e instanceof PackError ? e.problems.slice(0, 20) : []
  return { ok: false, error: (e as Error).message, ...(problems.length ? { problems } : {}) }
}

/** Names a community skill may not take: builtin skills and every app-pack id. */
export function takenNames(registry: SkillRegistry): string[] {
  const builtin = registry
    .all()
    .filter((s) => s.origin !== 'user' || s.overrides)
    .map((s) => s.manifest.name)
  return [...builtin, ...appPackIds(registry.roots.appPacks), ...appPackIds(registry.roots.user)]
}

function kindFor(registry: SkillRegistry): ReturnType<typeof agentSkillKind> {
  return agentSkillKind({ taken: () => takenNames(registry) })
}

/** What an archive would install, for the permissions screen. Nothing is written. */
export function previewArchive(
  registry: SkillRegistry,
  archive: Buffer,
  subpath?: string,
  source = ''
): Result<{ skills: SkillPreview[] }> {
  // Trust is pinned to source + archive hash (skills/state trustPin).
  const pin = trustPin({ source: source.slice(0, 500), sha256: sha256(archive) })
  try {
    const files = readZip(archive, ZIP_LIMITS)
    const packs = planPacks(files, kindFor(registry), subpath)
    const skills = packs.map((p): SkillPreview => {
      const { manifest: m } = parseSkillFile(
        p.files.find((f) => f.name === SKILL_FILE)!.data.toString('utf8')
      )
      return {
        name: m.name,
        description: m.description,
        version: m.version,
        ...(m.author ? { author: m.author } : {}),
        permissions: m.permissions,
        apps: m.apps,
        triggers: m.triggers,
        files: p.files.length,
        hasSteps: p.files.some((f) => f.name === 'steps.json'),
        updates: existsSync(join(registry.roots.user, m.name)),
        ...(resetsTrust(registry, m.name, pin) ? { resetsTrust: true } : {})
      }
    })
    return { ok: true, skills }
  } catch (e) {
    if (e instanceof NoPackError) return { ok: false, error: 'there are no skills in this file' }
    return failure(e)
  }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** The installed skill `name` is trusted now and the archive would replace it with another pack. */
function resetsTrust(registry: SkillRegistry, name: string, pin: string): boolean {
  const s = registry.get(name)
  return !!s && registry.trustOf(s) === 'community-trusted' && s.pin !== pin
}

/** Installs every skill in the archive as community-untrusted, then reloads. */
export function installArchive(
  registry: SkillRegistry,
  archive: Buffer,
  source: string,
  subpath?: string
): Result<{ installed: InstalledPack[] }> {
  try {
    const installed = installPacks(archive, {
      kind: kindFor(registry),
      destRoot: registry.roots.user,
      source,
      ...(subpath ? { subpath } : {})
    })
    registry.reload()
    // A trusted skill replaced by another pack (or other content) is untrusted again.
    for (const s of installed) if (s.updated) registry.dropStaleTrust(s.id)
    return { ok: true, installed }
  } catch (e) {
    if (e instanceof NoPackError) return { ok: false, error: 'there are no skills in this file' }
    return failure(e)
  }
}

/** A `.lumen` archive of one skill. */
export function exportSkill(registry: SkillRegistry, name: string): Result<{ data: Buffer }> {
  const s = registry.get(name)
  if (!s) return { ok: false, error: 'no such skill' }
  try {
    return { ok: true, data: exportPacks([s.dir], kindFor(registry)) }
  } catch (e) {
    return failure(e)
  }
}

function userDir(registry: SkillRegistry, name: string): string | null {
  if (!SKILL_NAME_RE.test(name) || RESERVED_DIRS.has(name)) return null
  const root = resolve(registry.roots.user)
  const dir = resolve(root, name)
  return dir.startsWith(root + sep) ? dir : null
}

/** A new skill in the user folder from the template. */
export function createSkill(
  registry: SkillRegistry,
  name: string,
  description: string
): Result<{ name: string }> {
  const dir = userDir(registry, name)
  if (!dir) return { ok: false, error: 'use lowercase words joined by "-", like "tidy-desktop"' }
  if (existsSync(dir) || registry.get(name))
    return { ok: false, error: `a skill or pack named "${name}" already exists` }
  if (appPackIds(registry.roots.appPacks).includes(name))
    return { ok: false, error: `"${name}" is the name of an app pack` }
  const text = skillTemplate(name, description.trim() || 'Describe what this skill does.')
  try {
    parseSkillFile(text)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_FILE), text, { encoding: 'utf8', flag: 'wx' })
  registry.reload()
  return { ok: true, name }
}

/**
 * Saves an edited SKILL.md. The name cannot change. A builtin or app-pack skill is copied to
 * the user folder first, and the copy overrides it from then on. A copy of a community skill
 * gets a pack marker of its own, so it stays untrusted (confirming every action) until the
 * user trusts it: an edit never turns community text into the user's own.
 */
export function saveSkillText(registry: SkillRegistry, name: string, text: string): Result {
  const s = registry.get(name)
  if (!s) return { ok: false, error: 'no such skill' }
  let parsed: ReturnType<typeof parseSkillFile>
  try {
    parsed = parseSkillFile(text)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if (parsed.manifest.name !== name)
    return { ok: false, error: 'the name cannot change; make a new skill instead' }
  let dir = s.dir
  if (s.origin !== 'user') {
    const target = userDir(registry, name)
    if (!target) return { ok: false, error: 'this skill cannot be copied to your folder' }
    if (existsSync(target)) return { ok: false, error: `a folder named "${name}" is in the way` }
    cpSync(s.dir, target, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).pop()!.startsWith('.')
    })
    if (s.baseTrust === 'community-untrusted') {
      const from = packMarker(s.dir) ?? packMarker(resolve(s.dir, '..', '..'))
      const marker: PackMarker = {
        format: 1,
        kind: SKILL_PACK_KIND,
        id: name,
        trust: 'community-untrusted',
        source: `edited copy of ${from?.source ?? s.source ?? name}`.slice(0, 500),
        sha256: from?.sha256 ?? '',
        installedAt: new Date().toISOString()
      }
      writeFileSync(join(target, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    }
    dir = target
  }
  writeFileSync(join(dir, SKILL_FILE), text.replace(/\r\n?/g, '\n'), 'utf8')
  registry.reload()
  return { ok: true }
}

/** Deletes a skill from the user folder; builtin and app-pack skills can only be switched off. */
export function deleteSkill(registry: SkillRegistry, name: string): Result {
  const s = registry.get(name)
  if (!s) return { ok: false, error: 'no such skill' }
  if (s.origin !== 'user')
    return { ok: false, error: 'skills that come with Lumen can only be switched off' }
  const dir = userDir(registry, name)
  if (!dir || resolve(s.dir) !== dir) return { ok: false, error: 'not in your skills folder' }
  if (s.baseTrust === 'community-untrusted') {
    if (!removePack(registry.roots.user, name, SKILL_PACK_KIND))
      return { ok: false, error: 'could not remove it' }
  } else {
    if (!existsSync(join(dir, SKILL_FILE))) return { ok: false, error: 'not a skill folder' }
    rmSync(dir, { recursive: true, force: true })
  }
  registry.reload()
  return { ok: true }
}

/** Bundled text files a written skill may carry: reference/<name>.md|.txt, small, few. */
export const EXTRA_FILE_RE = /^reference\/[a-z0-9][a-z0-9-]{0,40}\.(?:md|txt)$/
export const EXTRA_FILE_MAX_BYTES = 16 * 1024
export const EXTRA_FILES_MAX = 5

function extraProblem(extra: readonly { path: string; text: string }[]): string | null {
  if (extra.length > EXTRA_FILES_MAX) return `at most ${EXTRA_FILES_MAX} reference files`
  for (const f of extra) {
    if (!EXTRA_FILE_RE.test(f.path)) return `"${f.path}" is not a reference/<name>.md file`
    if (Buffer.byteLength(f.text, 'utf8') > EXTRA_FILE_MAX_BYTES)
      return `${f.path} is larger than 16 KB`
  }
  return null
}

/** A new skill in the user folder from finished files (a saved draft). */
export function writeNewSkill(
  registry: SkillRegistry,
  name: string,
  files: { skillMd: string; stepsJson?: string; extra?: { path: string; text: string }[] }
): Result<{ name: string }> {
  const dir = userDir(registry, name)
  if (!dir) return { ok: false, error: 'use lowercase words joined by "-", like "tidy-desktop"' }
  if (existsSync(dir) || registry.get(name))
    return { ok: false, error: `a skill or pack named "${name}" already exists` }
  if (appPackIds(registry.roots.appPacks).includes(name))
    return { ok: false, error: `"${name}" is the name of an app pack` }
  try {
    const parsed = parseSkillFile(files.skillMd)
    if (parsed.manifest.name !== name) return { ok: false, error: 'the name does not match' }
    if (files.stepsJson) parseStepsFile(files.stepsJson)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const bad = extraProblem(files.extra ?? [])
  if (bad) return { ok: false, error: bad }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_FILE), files.skillMd, { encoding: 'utf8', flag: 'wx' })
  if (files.stepsJson) writeFileSync(join(dir, STEPS_FILE), files.stepsJson, 'utf8')
  for (const f of files.extra ?? []) {
    mkdirSync(join(dir, 'reference'), { recursive: true })
    writeFileSync(join(dir, f.path), f.text.replace(/\r\n?/g, '\n'), 'utf8')
  }
  registry.reload()
  return { ok: true, name }
}

/**
 * Saves an edited skill (a reviewed voice edit or update): SKILL.md through saveSkillText (a
 * builtin is copied to the user folder first), then steps.json: a string replaces it, null
 * removes it, undefined keeps it.
 */
export function saveSkillFiles(
  registry: SkillRegistry,
  name: string,
  files: { skillMd: string; stepsJson?: string | null }
): Result {
  if (typeof files.stepsJson === 'string') {
    try {
      parseStepsFile(files.stepsJson)
    } catch (e) {
      return { ok: false, error: `steps.json: ${(e as Error).message}` }
    }
  }
  const r = saveSkillText(registry, name, files.skillMd)
  if (!r.ok || files.stepsJson === undefined) return r
  const s = registry.get(name)
  const dir = userDir(registry, name)
  if (!s || !dir || resolve(s.dir) !== dir) return { ok: false, error: 'not in your skills folder' }
  const file = join(dir, STEPS_FILE)
  if (files.stepsJson === null) rmSync(file, { force: true })
  else writeFileSync(file, files.stepsJson, 'utf8')
  registry.reload()
  return { ok: true }
}
