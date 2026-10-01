import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { SkillRoots } from '../../src/main/skills/registry'

export interface TempRoots extends SkillRoots {
  base: string
  cleanup(): void
}

export function tempRoots(): TempRoots {
  const base = mkdtempSync(join(tmpdir(), 'lumen-skills-'))
  const roots = {
    base,
    builtin: join(base, 'app', 'skills', 'builtin'),
    appPacks: join(base, 'app', 'skills'),
    user: join(base, 'home', 'skills'),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
  mkdirSync(roots.builtin, { recursive: true })
  mkdirSync(roots.user, { recursive: true })
  return roots
}

export function skillMd(
  name: string,
  opts: { description?: string; extra?: string; body?: string } = {}
): string {
  return `---
name: ${name}
description: ${opts.description ?? `Does the ${name} thing.`}
${opts.extra ?? ''}
---
${opts.body ?? `Steps for ${name}.`}
`
}

export function writeSkill(
  root: string,
  name: string,
  opts: Parameters<typeof skillMd>[1] & { files?: Record<string, string>; folder?: string } = {}
): string {
  const dir = join(root, opts.folder ?? name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name, opts))
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

/** A minimal app pack folder (07 skill.json) so the loader treats it as an app pack. */
export function writeAppPack(root: string, id: string): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({ id, name: id, version: '1.0.0' }))
  return dir
}
