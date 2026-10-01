// Skill files on disk (11 T05/T06): install previews (the permissions screen), install, export,
// create, edit and delete. Installs go through the generic `.lumen` installer (src/main/packs)
// with the agent-skill PackKind, so the zip checks, staging and markers are shared with lesson
// packs. Only the user folder is ever written; builtin and app-pack skills are copied there to
// be edited (the copy overrides them). No Electron.
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
  type InstalledPack
} from '../packs/install'
import { readZip, ZIP_LIMITS } from '../packs/zip-read'
import { agentSkillKind } from './kind'
import { SKILL_FILE, SKILL_NAME_RE, parseSkillFile, skillTemplate } from './manifest'
import { RESERVED_DIRS, SKILL_PACK_KIND, appPackIds, type SkillRegistry } from './registry'
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
  subpath?: string
): Result<{ skills: SkillPreview[] }> {
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
        updates: existsSync(join(registry.roots.user, m.name))
      }
    })
    return { ok: true, skills }
  } catch (e) {
    if (e instanceof NoPackError) return { ok: false, error: 'there are no skills in this file' }
    return failure(e)
  }
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
 * the user folder first, and the copy overrides it from then on.
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

/** A new skill in the user folder from finished files (a saved draft). */
export function writeNewSkill(
  registry: SkillRegistry,
  name: string,
  files: { skillMd: string; stepsJson?: string }
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
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_FILE), files.skillMd, { encoding: 'utf8', flag: 'wx' })
  if (files.stepsJson) writeFileSync(join(dir, STEPS_FILE), files.stepsJson, 'utf8')
  registry.reload()
  return { ok: true, name }
}
