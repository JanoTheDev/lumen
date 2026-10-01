// Skills as a `.lumen` PackKind (11 T06, CONTRACTS C10): a pack folder is a skill folder with
// SKILL.md at its root. Data files only (no scripts, ever); SKILL.md must parse, its name must
// match the folder, steps.json must be JSON. Builtin skill names, app-pack ids and reserved
// folder names cannot be taken by a community skill. No Electron.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { PackKind } from '../packs/install'
import { MAX_SKILL_FILE_BYTES, SKILL_FILE, parseSkillFile } from './manifest'
import { RESERVED_DIRS, SKILL_PACK_KIND } from './registry'

export const SKILL_FILE_EXT = [
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
] as const

export interface AgentSkillKindOptions {
  /** Names a community skill may not use: builtin skills and app-pack ids. */
  taken: () => Iterable<string>
}

export function agentSkillKind(opts: AgentSkillKindOptions): PackKind {
  return {
    name: SKILL_PACK_KIND,
    manifest: SKILL_FILE,
    allowedExt: SKILL_FILE_EXT,
    plainNames: ['LICENSE', 'NOTICE', 'README'],
    idOf(manifest) {
      if (manifest.length > MAX_SKILL_FILE_BYTES) throw new Error(`${SKILL_FILE} is too large`)
      return parseSkillFile(manifest.toString('utf8')).manifest.name
    },
    reserved(id) {
      if (RESERVED_DIRS.has(id)) return `"${id}" is a reserved name`
      if ([...opts.taken()].includes(id))
        return `"${id}" is the name of a skill or app that ships with Lumen`
      return null
    },
    validate(dir) {
      return validateSkillDir(dir)
    }
  }
}

/** Problems with an unpacked skill folder; [] = fine. */
export function validateSkillDir(dir: string): string[] {
  const problems: string[] = []
  const folder = dir.split(/[\\/]/).pop()!
  try {
    const file = join(dir, SKILL_FILE)
    if (statSync(file).size > MAX_SKILL_FILE_BYTES) problems.push(`${SKILL_FILE} is too large`)
    const { manifest } = parseSkillFile(readFileSync(file, 'utf8'))
    if (manifest.name !== folder)
      problems.push(`${SKILL_FILE}: name "${manifest.name}" must match the folder "${folder}"`)
  } catch (e) {
    problems.push(`${SKILL_FILE}: ${(e as Error).message}`)
  }
  for (const f of jsonFiles(dir)) {
    try {
      JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      problems.push(`${f}: not valid JSON`)
    }
  }
  return problems
}

function jsonFiles(dir: string, sub = '', depth = 0): string[] {
  if (depth > 4) return []
  const out: string[] = []
  const here = join(dir, sub)
  if (!existsSync(here)) return out
  for (const n of readdirSync(here)) {
    const rel = sub ? `${sub}/${n}` : n
    if (statSync(join(dir, rel)).isDirectory()) out.push(...jsonFiles(dir, rel, depth + 1))
    else if (n.toLowerCase().endsWith('.json')) out.push(rel)
  }
  return out
}
