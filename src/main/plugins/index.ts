// Claude Code plugin import (plugins:*): read a source, show what Lumen would take and leave
// out, then install the converted skills through the normal skill installer and add the
// connectors the user trusted. A preview waits 10 minutes for its import.
import { randomBytes } from 'crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import type {
  ClaudeHomeScan,
  PluginEnvChoice,
  PluginImportResult,
  PluginPreviewResult,
  PluginSource,
  PluginSkillPreview
} from '@shared/plugins'
import { claudeHome } from '../claude-code/projects'
import { connectors } from '../connectors'
import { INVALID, safeParse } from '../ipc/validate'
import { log } from '../logger'
import { getSkillRegistry } from '../skills'
import { installArchive, previewArchive, takenNames } from '../skills/manage'
import { chosenEnv, convertPlugin } from './convert'
import { fetchPack } from '../packs/fetch'
import { findPlugins, type FoundPlugin, type RemoteEntry, type TreeFile } from './layout'
import { planImport, type ImportPlan, type NameOwner } from './plan'
import { fetchRemotePlugins } from './remote'
import { readClaudeHome, readFolder, readGithub, scanClaudeHome, SourceError } from './sources'

const PENDING_MS = 10 * 60_000
const pending = new Map<string, { plan: ImportPlan; at: number }>()

interface Trees {
  trees: { label?: string; files: TreeFile[] }[]
  source: string
}

async function read(req: PluginSource, sender?: Electron.WebContents): Promise<Trees | null> {
  if (req.kind === 'github') {
    const r = await readGithub(req.url)
    return { trees: [{ files: r.files }], source: r.source }
  }
  if (req.kind === 'folder') {
    const parent = (sender && BrowserWindow.fromWebContents(sender)) || undefined
    const opts: Electron.OpenDialogOptions = {
      title: 'Import a Claude Code plugin or skills folder',
      properties: ['openDirectory']
    }
    const pick = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    const dir = pick.filePaths[0]
    if (pick.canceled || !dir) return null
    const r = readFolder(dir)
    return { trees: [{ files: r.files }], source: r.source }
  }
  return { trees: readClaudeHome(claudeHome()).trees, source: 'claude-code:~/.claude' }
}

/** Who holds a skill name now (for renaming on clashes). */
function nameOwner(): NameOwner {
  const registry = getSkillRegistry()
  const taken = new Set(registry ? takenNames(registry) : [])
  return {
    owner(name, source) {
      if (taken.has(name)) return 'other'
      const s = registry?.get(name)
      if (!s) return 'free'
      return s.source === source ? 'same-source' : 'other'
    }
  }
}

async function plugins(trees: Trees['trees']): Promise<{
  found: { plugin: FoundPlugin; converted: ReturnType<typeof convertPlugin> }[]
  skipped: ImportPlan['skipped']
}> {
  const found: { plugin: FoundPlugin; converted: ReturnType<typeof convertPlugin> }[] = []
  const skipped: ImportPlan['skipped'] = []
  const remote: RemoteEntry[] = []
  for (const t of trees) {
    const r = findPlugins(t.files)
    skipped.push(...r.skipped)
    remote.push(...r.remote)
    for (const p of r.plugins) {
      const plugin = t.label && !p.manifest.name ? { ...p, name: t.label } : p
      found.push({ plugin, converted: convertPlugin(t.files, plugin) })
    }
  }
  if (remote.length) {
    const r = await fetchRemotePlugins(remote, (url) => fetchPack(url))
    skipped.push(...r.skipped)
    for (const p of r.plugins)
      found.push({ plugin: p.plugin, converted: convertPlugin(p.files, p.plugin) })
  }
  return { found, skipped }
}

export async function previewPlugins(
  req: PluginSource,
  sender?: Electron.WebContents
): Promise<PluginPreviewResult> {
  const registry = getSkillRegistry()
  if (!registry) return { ok: false, error: 'skills are not ready yet' }
  let trees: Trees | null
  try {
    trees = await read(req, sender)
  } catch (e) {
    const msg = (e as Error).message
    log('fail', `plugin import: ${msg}`)
    return { ok: false, error: e instanceof SourceError ? msg : `could not read it: ${msg}` }
  }
  if (!trees) return { ok: false, error: 'cancelled' }
  const { found, skipped } = await plugins(trees.trees)
  if (!found.length)
    return { ok: false, error: 'no Claude Code plugin, marketplace or skills were found there' }
  const existing = connectors()
    .list()
    .map((c) => ({ id: c.id, commandLine: c.commandLine, url: c.url }))
  const plan = planImport(found, trees.source, nameOwner(), existing, skipped)
  const extra = new Map<string, Pick<PluginSkillPreview, 'updates' | 'resetsTrust'>>()
  for (const a of plan.archives) {
    const r = previewArchive(registry, a.archive, undefined, a.source)
    if (!r.ok) return { ok: false, error: r.error, ...(r.problems ? { problems: r.problems } : {}) }
    for (const s of r.skills)
      extra.set(s.name, { updates: s.updates, ...(s.resetsTrust ? { resetsTrust: true } : {}) })
  }
  if (!plan.skills.length && !plan.servers.length)
    return {
      ok: false,
      error: 'there is nothing Lumen can use in it',
      problems: plan.skipped.map((s) => `${s.what}: ${s.why}`).slice(0, 20)
    }
  const now = Date.now()
  for (const [k, v] of pending) if (now - v.at > PENDING_MS) pending.delete(k)
  const token = randomBytes(12).toString('hex')
  pending.set(token, { plan, at: now })
  log(
    'plan',
    `plugin import preview: ${plan.skills.length} skills, ${plan.servers.length} connectors`
  )
  return {
    ok: true,
    token,
    source: trees.source,
    plugins: plan.plugins,
    skills: plan.skills.map((s) => ({
      ...s.preview,
      ...(extra.get(s.preview.name) ?? { updates: false })
    })),
    connectors: plan.servers.map((s) => s.preview),
    skipped: plan.skipped
  }
}

export function importPlugins(
  token: string,
  connectorKeys: string[],
  envChoices: Record<string, PluginEnvChoice> = {}
): PluginImportResult {
  const p = pending.get(token)
  pending.delete(token)
  if (!p || Date.now() - p.at > PENDING_MS)
    return { ok: false, error: 'that import expired; start it again' }
  const registry = getSkillRegistry()
  if (!registry) return { ok: false, error: 'skills are not ready yet' }
  const skills: { name: string; updated: boolean }[] = []
  for (const a of p.plan.archives) {
    const r = installArchive(registry, a.archive, a.source)
    if (!r.ok) return { ok: false, error: r.error, ...(r.problems ? { problems: r.problems } : {}) }
    for (const s of r.installed) skills.push({ name: s.id, updated: s.updated })
    log('done', `plugin ${a.plugin}: ${r.installed.length} skills imported`)
  }
  const chosen = new Set(connectorKeys)
  const added: { id: string; ok: boolean; error?: string }[] = []
  for (const s of p.plan.servers) {
    if (!chosen.has(s.preview.key) || s.preview.exists === 'same') continue
    const i = s.offer.input
    const env = chosenEnv(s.offer, envChoices[s.preview.key])
    const r = connectors().add({
      id: s.preview.id,
      name: i.name,
      transport: i.transport,
      ...(i.transport === 'stdio'
        ? {
            command: i.command,
            args: i.args ?? [],
            trustCommand: true,
            ...(Object.keys(env).length ? { env } : {})
          }
        : { url: i.url })
    })
    added.push({ id: s.preview.id, ok: r.ok, ...(r.ok ? {} : { error: r.error }) })
  }
  return { ok: true, skills, connectors: added }
}

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), url: z.string().trim().min(8).max(500) }).strict(),
  z.object({ kind: z.literal('folder') }).strict(),
  z.object({ kind: z.literal('claude-home') }).strict()
])
const importSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{24}$/),
    connectors: z.array(z.string().max(200)).max(100),
    env: z
      .record(
        z.string().max(200),
        z
          .object({
            values: z
              .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4000))
              .optional(),
            keep: z.array(z.string().max(64)).max(30).optional()
          })
          .strict()
      )
      .optional()
  })
  .strict()

export function registerPluginsIpc(): void {
  ipcMain.handle('plugins:scan', (): ClaudeHomeScan => scanClaudeHome(claudeHome()))
  ipcMain.handle('plugins:preview', (e, raw: unknown) => {
    const req = safeParse('plugins:preview', sourceSchema, raw)
    return req ? previewPlugins(req, e.sender) : INVALID
  })
  ipcMain.handle('plugins:import', (_e, raw: unknown) => {
    const req = safeParse('plugins:import', importSchema, raw)
    return req ? importPlugins(req.token, req.connectors, req.env) : INVALID
  })
  ipcMain.handle('plugins:cancel', (_e, raw: unknown) => {
    const token = safeParse('plugins:cancel', importSchema.shape.token, raw)
    return { ok: token ? pending.delete(token) : false }
  })
}
