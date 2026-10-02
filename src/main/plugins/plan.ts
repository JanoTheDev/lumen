// An import plan: final skill names (a name another skill already uses gets the plugin's name in
// front), the `.lumen` archive of the converted skills for the normal skill installer (so the
// zip checks, markers and source + hash trust pin are the same as any community skill), and
// the connector offers with free ids. Re-importing the same source with the same content gives
// the same archive bytes, so trust stays; changed content resets it. Pure. No Electron.
import type { PluginConnectorPreview, PluginSkillPreview, PluginSkipped } from '@shared/plugins'
import { commandLine } from '@shared/connectors'
import { zip, type ZipEntry } from '../packs/zip-write'
import { kebab, type ConvertedPlugin, type ConvertedSkill, type OfferedServer } from './convert'
import type { FoundPlugin } from './layout'

export interface NameOwner {
  /** Who has `name` now: nobody, an earlier import from `source`, or someone else. */
  owner(name: string, source: string): 'free' | 'same-source' | 'other'
}

export interface ExistingConnector {
  id: string
  commandLine?: string
  url?: string
}

export interface ImportPlan {
  plugins: { name: string; version?: string; description?: string }[]
  skills: { skill: ConvertedSkill; preview: Omit<PluginSkillPreview, 'updates' | 'resetsTrust'> }[]
  servers: { offer: OfferedServer; preview: PluginConnectorPreview }[]
  skipped: PluginSkipped[]
  /** One archive per plugin with skills (its own trust pin), with the source it is installed as. */
  archives: { plugin: string; source: string; archive: Buffer }[]
}

/** The marker source of one plugin's skills: the link alone, or link + plugin name. */
export function pluginSource(source: string, plugin: string, many: boolean): string {
  return many ? `${source}::${plugin}` : source
}

/**
 * Gives each plugin of one import its own name (`x`, then `x-2` …), so two plugins called the
 * same never share an archive, a trust source or connector keys.
 */
export function uniquePluginNamer(): (p: FoundPlugin) => FoundPlugin {
  const seen = new Set<string>()
  return (p) => {
    let name = p.name
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = `${p.name}-${i}`
    seen.add(name.toLowerCase())
    return name === p.name ? p : { ...p, name }
  }
}

function freeSkillName(
  base: string,
  plugin: string,
  source: string,
  used: Set<string>,
  names: NameOwner
): string {
  const ok = (n: string): boolean => !used.has(n) && names.owner(n, source) !== 'other'
  if (ok(base)) return base
  const prefixed = kebab(`${plugin} ${base}`, 64)
  if (prefixed && ok(prefixed)) return prefixed
  const root = (prefixed || base).slice(0, 58).replace(/-+$/, '')
  for (let i = 2; i < 100; i++) if (ok(`${root}-${i}`)) return `${root}-${i}`
  return `${root}-${Date.now().toString(36)}`.slice(0, 64)
}

function freeServerId(base: string, used: Set<string>): string {
  const root = base.slice(0, 20).replace(/-+$/, '') || 'server'
  if (!used.has(root)) return root
  for (let i = 2; i < 100; i++) {
    const id = `${root.slice(0, 17).replace(/-+$/, '')}-${i}`
    if (!used.has(id)) return id
  }
  return root
}

/** Renames the skill (folder and SKILL.md `name:` line). */
function renamed(s: ConvertedSkill, name: string): ConvertedSkill {
  if (s.name === name) return s
  const md = s.files[0].data.toString('utf8').replace(/^name: .*$/m, `name: ${name}`)
  return {
    name,
    files: [{ name: 'SKILL.md', data: Buffer.from(md, 'utf8') }, ...s.files.slice(1)],
    preview: {
      ...s.preview,
      name,
      notes: [...s.preview.notes, `renamed to "${name}" because "${s.name}" is taken`]
    }
  }
}

export function planImport(
  found: { plugin: FoundPlugin; converted: ConvertedPlugin }[],
  source: string,
  names: NameOwner,
  connectors: readonly ExistingConnector[],
  skipped: PluginSkipped[] = []
): ImportPlan {
  const used = new Set<string>()
  const skills: (ImportPlan['skills'][number] & { plugin: string })[] = []
  const servers: ImportPlan['servers'] = []
  const ids = new Set(connectors.map((c) => c.id))
  const out: PluginSkipped[] = [...skipped]
  for (const { plugin, converted } of found) {
    const src = pluginSource(source, plugin.name, found.length > 1)
    for (const s of converted.skills) {
      const r = renamed(s, freeSkillName(s.name, plugin.name, src, used, names))
      used.add(r.name)
      skills.push({ skill: r, preview: r.preview, plugin: plugin.name })
    }
    for (const offer of converted.servers) {
      const line =
        offer.input.transport === 'stdio'
          ? commandLine(offer.input.command, offer.input.args)
          : undefined
      // The same server from an earlier import keeps its id.
      const same = connectors.find((c) =>
        line ? c.commandLine === line : c.url !== undefined && c.url === offer.input.url
      )
      const id = same?.id ?? freeServerId(offer.idBase, ids)
      ids.add(id)
      servers.push({
        offer,
        preview: { ...offer.preview, id, ...(same ? { exists: 'same' as const } : {}) }
      })
    }
    out.push(...converted.skipped)
  }
  const archives: ImportPlan['archives'] = []
  for (const { plugin } of found) {
    const entries: ZipEntry[] = skills
      .filter((s) => s.plugin === plugin.name)
      .sort((a, b) => a.skill.name.localeCompare(b.skill.name))
      .flatMap(({ skill }) =>
        [...skill.files]
          .sort((a, b) =>
            a.name === 'SKILL.md' ? -1 : b.name === 'SKILL.md' ? 1 : a.name.localeCompare(b.name)
          )
          .map((f) => ({ name: `${skill.name}/${f.name}`, data: f.data }))
      )
    if (entries.length)
      archives.push({
        plugin: plugin.name,
        source: pluginSource(source, plugin.name, found.length > 1),
        archive: zip(entries)
      })
  }
  return {
    plugins: found.map(({ plugin: p }) => ({
      name: p.name,
      ...(p.version ? { version: p.version } : {}),
      ...(p.description ? { description: p.description } : {})
    })),
    skills: skills.map(({ skill, preview }) => ({ skill, preview })),
    servers,
    skipped: out,
    archives
  }
}
