// Claude Code plugin parts → Lumen. Skills (skills/<name>/SKILL.md) and commands
// (commands/*.md) become Lumen skills with Lumen's own header (least privilege: no input,
// network, files or connectors until the user edits it); output styles become reply styles
// (`kind: style`); .mcp.json servers become connector offers that each need the user's trust.
// Fields Lumen cannot honor are dropped with a note. Hooks, agents and scripts are never
// imported: they run code on the user's PC when Claude Code events fire, which Lumen does not
// do for anything it did not write itself. Pure. No Electron.
import type { PluginConnectorPreview, PluginSkillPreview, PluginSkipped } from '@shared/plugins'
import { commandLine } from '@shared/connectors'
import { splitFrontmatter, type YamlValue } from '../skills/frontmatter'
import { SKILL_FILE_EXT } from '../skills/kind'
import { MAX_SKILL_FILE_BYTES } from '../skills/manifest'
import { joinRel, pathList, readJson, type FoundPlugin, type TreeFile } from './layout'

export interface ConvertedSkill {
  name: string
  /** Files relative to the skill folder, SKILL.md first. */
  files: TreeFile[]
  preview: Omit<PluginSkillPreview, 'updates' | 'resetsTrust'>
}

export interface OfferedServer {
  preview: Omit<PluginConnectorPreview, 'id' | 'exists'>
  /** Base for the connector id. */
  idBase: string
  input: {
    name: string
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
  }
}

export interface ConvertedPlugin {
  skills: ConvertedSkill[]
  servers: OfferedServer[]
  skipped: PluginSkipped[]
}

const VERSION_RE = /^\d+(\.\d+){0,2}([-+][\w.]+)?$/
const MAX_DESC = 200
const SCRIPT_RE =
  /\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|ps1|psm1|bat|cmd|exe|dll|rb|pl|php|lua|go|rs|jar)$/i

/** Lowercase words joined by "-", ≤ max chars; "" when nothing is left. */
export function kebab(text: string, max = 64): string {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > max) break
    out = next
  }
  return out
}

/** One line, cut at a word to `max` characters. */
export function clip(text: string, max = MAX_DESC): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const cut = one.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`
}

const q = (s: string): string => JSON.stringify(s)

function firstLine(body: string): string {
  for (const l of body.split('\n')) {
    const t = l.replace(/^#+\s*/, '').trim()
    if (t) return t
  }
  return ''
}

/** Claude header fields and what Lumen does with them. */
const FIELD_NOTES: Record<string, string> = {
  'allowed-tools': 'Claude Code tool permissions are not carried over; Lumen asks per action',
  'disallowed-tools': 'Claude Code tool limits are not carried over',
  model: 'the Claude model choice is dropped; Lumen uses its own model settings',
  effort: 'the effort setting is dropped',
  context: 'it ran in a separate subagent in Claude Code; in Lumen it runs as a normal skill',
  agent: 'the subagent type is dropped',
  hooks: 'its hooks are not imported (they run commands on your PC)',
  paths: 'the file patterns it was limited to are dropped',
  shell: 'the shell setting is dropped',
  'user-invocable': 'dropped: every Lumen skill can be started by voice',
  compatibility: 'its compatibility note is dropped',
  arguments: 'named arguments become one "arguments" value',
  'argument-hint': '',
  'disable-model-invocation': '',
  name: '',
  description: '',
  when_to_use: '',
  license: '',
  version: '',
  metadata: '',
  'keep-coding-instructions': '',
  'force-for-plugin': ''
}

function headerNotes(data: Record<string, YamlValue>): string[] {
  const notes: string[] = []
  for (const k of Object.keys(data)) {
    const n = FIELD_NOTES[k]
    if (n === undefined) notes.push(`"${k}" is not used by Lumen`)
    else if (n) notes.push(n)
  }
  return notes
}

/** Claude body syntax Lumen does not run or fill. Returns the new body and notes. */
export function convertBody(body: string): { body: string; notes: string[]; usesArgs: boolean } {
  const notes: string[] = []
  let out = body
  // Dynamic context: !`command` and ```! blocks run shell commands when Claude loads a skill.
  const inline = /(^|\s)!`([^`\n]*)`/g
  const block = /^```!\s*$/gm
  if (inline.test(out) || block.test(out)) {
    notes.push('commands it ran while loading are kept as plain text; Lumen never runs them')
    out = out.replace(/(^|\s)!`([^`\n]*)`/g, '$1`$2`').replace(/^```!\s*$/gm, '```')
  }
  const usesArgs = /\$ARGUMENTS\b/.test(out)
  if (usesArgs) out = out.replace(/\$ARGUMENTS\b/g, '{arguments}')
  if (/(^|[^\\\w])\$\d\b/.test(out))
    notes.push('numbered arguments ($1, $2 …) are not filled in; say them in your request')
  if (/\$\{(?:CLAUDE_[A-Z_]+|user_config\.[\w.]+)\}/.test(out))
    notes.push('it refers to Claude Code folders or settings that Lumen does not have')
  return { body: out, notes, usesArgs }
}

interface SkillHeader {
  name: string
  description: string
  whenToUse?: string
  version: string
  author?: string
  license?: string
  triggers: string[]
  argHint?: string
  usesArgs: boolean
  style: boolean
}

/** A Lumen SKILL.md (the YAML subset Lumen reads: JSON-quoted strings). */
export function renderLumenSkill(h: SkillHeader, body: string): string {
  const lines = [
    '---',
    `name: ${h.name}`,
    `description: ${q(h.description)}`,
    ...(h.whenToUse ? [`when_to_use: ${q(h.whenToUse)}`] : []),
    `version: ${h.version}`,
    ...(h.author ? [`author: ${q(h.author)}`] : []),
    ...(h.license ? [`license: ${q(h.license)}`] : []),
    ...(h.style ? ['kind: style'] : []),
    ...(!h.style && h.triggers.length ? [`triggers: [${h.triggers.map(q).join(', ')}]`] : []),
    ...(!h.style && h.usesArgs
      ? [
          'params:',
          '  arguments:',
          '    type: string',
          '    default: ""',
          `    description: ${q(clip(h.argHint ? `What to work on, e.g. ${h.argHint}` : 'What to work on', 200))}`
        ]
      : []),
    '---'
  ]
  return `${lines.join('\n')}\n${body.trim()}\n`
}

function header(
  data: Record<string, YamlValue>,
  fallbackName: string,
  body: string,
  plugin: FoundPlugin
): Omit<SkillHeader, 'triggers' | 'usesArgs' | 'style'> & { rawDescription: string } {
  const raw = typeof data.description === 'string' ? data.description : firstLine(body)
  const when = typeof data.when_to_use === 'string' ? data.when_to_use : ''
  const ver = typeof data.version === 'string' ? data.version : (plugin.version ?? '')
  const lic = typeof data.license === 'string' ? data.license : plugin.license
  const name = typeof data.name === 'string' && data.name.trim() ? data.name : fallbackName
  return {
    name: kebab(name) || kebab(fallbackName) || 'imported-skill',
    description: clip(raw || `Imported from the Claude Code plugin ${plugin.name}.`),
    rawDescription: raw,
    ...(when ? { whenToUse: clip(when) } : {}),
    version: VERSION_RE.test(ver) ? ver : '1.0.0',
    ...(plugin.author ? { author: clip(plugin.author, 80) } : {}),
    ...(lic ? { license: clip(lic, 80) } : {}),
    ...(typeof data['argument-hint'] === 'string'
      ? { argHint: clip(data['argument-hint'], 80) }
      : {})
  }
}

function parseMd(text: string): { data: Record<string, YamlValue>; body: string } {
  const src = text.trimStart()
  if (!/^---[ \t]*\r?\n/.test(src)) return { data: {}, body: src.trim() }
  return splitFrontmatter(src)
}

/** "review-pr" → ["review pr"]: a trigger only for names of two or more words. */
function triggersFor(name: string): string[] {
  const words = name.split('-')
  return words.length >= 2 && name.length >= 6 ? [words.join(' ')] : []
}

function convertMd(
  kind: 'skill' | 'command' | 'output-style',
  text: string,
  fallbackName: string,
  plugin: FoundPlugin,
  extra: TreeFile[] = []
): ConvertedSkill {
  if (Buffer.byteLength(text) > MAX_SKILL_FILE_BYTES) throw new Error('the file is too large')
  const { data, body } = parseMd(text)
  const h = header(data, fallbackName, body, plugin)
  const notes = headerNotes(data)
  if (h.rawDescription.length > MAX_DESC) notes.push('its description was shortened')
  const conv = kind === 'output-style' ? { body, notes: [], usesArgs: false } : convertBody(body)
  notes.push(...conv.notes)
  const style = kind === 'output-style'
  const triggers =
    kind === 'command' || data['disable-model-invocation'] === true ? triggersFor(h.name) : []
  const md = renderLumenSkill({ ...h, triggers, usesArgs: conv.usesArgs, style }, conv.body)
  return {
    name: h.name,
    files: [{ name: 'SKILL.md', data: Buffer.from(md, 'utf8') }, ...extra],
    preview: {
      name: h.name,
      description: h.description,
      from: kind,
      plugin: plugin.name,
      kind: style ? 'style' : 'task',
      triggers,
      notes: [...new Set(notes)]
    }
  }
}

const allowedExt = (name: string): boolean => {
  const base = name.split('/').pop()!
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return /^(LICENSE|NOTICE|README)$/i.test(base)
  return (SKILL_FILE_EXT as readonly string[]).includes(base.slice(dot).toLowerCase())
}

/** The extra files of a skill folder Lumen can keep (data only), and notes on the rest. */
function skillExtras(
  files: readonly TreeFile[],
  dir: string
): { keep: TreeFile[]; notes: string[] } {
  const keep: TreeFile[] = []
  let scripts = 0
  let other = 0
  let badJson = 0
  for (const f of files) {
    if (!f.name.startsWith(dir)) continue
    const rel = f.name.slice(dir.length)
    if (rel === 'SKILL.md' || rel.split('/').some((p) => p.startsWith('.'))) continue
    if (rel.endsWith('/SKILL.md') || rel === 'steps.json') {
      other++
      continue
    }
    if (SCRIPT_RE.test(rel)) {
      scripts++
      continue
    }
    if (!allowedExt(rel)) {
      other++
      continue
    }
    if (rel.toLowerCase().endsWith('.json')) {
      try {
        JSON.parse(f.data.toString('utf8'))
      } catch {
        badJson++
        continue
      }
    }
    keep.push({ name: rel, data: f.data })
  }
  const notes: string[] = []
  if (scripts)
    notes.push(`${scripts} script file(s) left out: Lumen never runs scripts from skills`)
  if (other) notes.push(`${other} other file(s) left out (only text, data and images are kept)`)
  if (badJson) notes.push(`${badJson} unreadable JSON file(s) left out`)
  return { keep, notes }
}

/** Skill folders of a plugin: default skills/ plus plugin.json `skills` paths. */
function skillDirs(files: readonly TreeFile[], p: FoundPlugin): string[] {
  const roots = [`${p.prefix}skills/`]
  for (const rel of pathList(p.manifest.skills)) {
    const path = joinRel(p.prefix, rel)
    if (path !== null) roots.push(path ? `${path}/` : '')
  }
  const dirs = new Set<string>()
  for (const root of roots) {
    if (files.some((f) => f.name === `${root}SKILL.md`)) {
      dirs.add(root)
      continue
    }
    for (const f of files) {
      if (!f.name.startsWith(root)) continue
      const rest = f.name.slice(root.length).split('/')
      if (rest.length === 2 && rest[1] === 'SKILL.md') dirs.add(`${root}${rest[0]}/`)
    }
  }
  return [...dirs].sort()
}

function mdFilesIn(files: readonly TreeFile[], dir: string, depth = 2): TreeFile[] {
  return files.filter((f) => {
    if (!f.name.startsWith(dir) || !f.name.toLowerCase().endsWith('.md')) return false
    const rest = f.name.slice(dir.length).split('/')
    return (
      rest.length <= depth &&
      !rest.some((x) => x.startsWith('.')) &&
      !/^readme\.md$/i.test(rest.at(-1)!)
    )
  })
}

/** Command files: plugin.json `commands` (files, folders or a name map) else commands/. */
function commandSources(
  files: readonly TreeFile[],
  p: FoundPlugin
): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const stem = (n: string): string => n.split('/').pop()!.replace(/\.md$/i, '')
  const c = p.manifest.commands
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    for (const [name, v] of Object.entries(c as Record<string, unknown>)) {
      const o = (v ?? {}) as Record<string, unknown>
      if (typeof o.content === 'string') {
        const head =
          typeof o.description === 'string' ? `---\ndescription: ${q(o.description)}\n---\n` : ''
        out.push({ name, text: `${head}${o.content}` })
      } else if (typeof o.source === 'string') {
        const path = joinRel(p.prefix, o.source)
        const f = path && files.find((x) => x.name === path)
        if (f) out.push({ name, text: f.data.toString('utf8') })
      }
    }
    return out
  }
  const paths = pathList(c)
  const dirs = paths.length ? paths : ['./commands']
  for (const rel of dirs) {
    const path = joinRel(p.prefix, rel)
    if (path === null) continue
    const file = files.find((x) => x.name === path && path.toLowerCase().endsWith('.md'))
    const list = file ? [file] : mdFilesIn(files, path ? `${path}/` : '')
    for (const f of list) out.push({ name: stem(f.name), text: f.data.toString('utf8') })
  }
  return out
}

function styleSources(files: readonly TreeFile[], p: FoundPlugin): TreeFile[] {
  const paths = pathList(p.manifest.outputStyles)
  const out: TreeFile[] = []
  for (const rel of paths.length ? paths : ['./output-styles']) {
    const path = joinRel(p.prefix, rel)
    if (path === null) continue
    const file = files.find((x) => x.name === path && path.toLowerCase().endsWith('.md'))
    out.push(...(file ? [file] : mdFilesIn(files, path ? `${path}/` : '', 1)))
  }
  return out
}

// ---- MCP servers ----

const PLUGIN_VAR =
  /\$\{(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_[A-Z_]+)\}/
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** `${VAR:-default}` → default; plain `${VAR}` stays (reported as needed). */
function expandDefaults(s: string): { text: string; needs: string[] } {
  const needs: string[] = []
  const text = s.replace(VAR, (all, name: string, def?: string) => {
    if (def !== undefined) return def
    needs.push(name)
    return all
  })
  return { text, needs }
}

function serverMaps(files: readonly TreeFile[], p: FoundPlugin): Record<string, unknown>[] {
  const maps: Record<string, unknown>[] = []
  const take = (o: Record<string, unknown> | null): void => {
    if (!o) return
    const inner = o.mcpServers
    maps.push(
      inner && typeof inner === 'object' && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : o
    )
  }
  take(readJson(files, `${p.prefix}.mcp.json`))
  const m = p.manifest.mcpServers
  if (m && typeof m === 'object' && !Array.isArray(m)) take(m as Record<string, unknown>)
  for (const item of Array.isArray(m) ? m : [m]) {
    if (typeof item === 'string' && item.toLowerCase().endsWith('.json')) {
      const path = joinRel(p.prefix, item)
      if (path) take(readJson(files, path))
    } else if (item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(m))
      take(item as Record<string, unknown>)
  }
  return maps
}

function offerServer(
  key: string,
  name: string,
  raw: Record<string, unknown>,
  p: FoundPlugin,
  skipped: PluginSkipped[]
): OfferedServer | null {
  const what = `connector "${name}" (${p.name})`
  const type =
    typeof raw.type === 'string' ? raw.type : typeof raw.command === 'string' ? 'stdio' : 'http'
  if (raw.disabled === true) {
    skipped.push({ what, why: 'it is switched off in the plugin' })
    return null
  }
  if (type === 'sse' || type === 'ws') {
    skipped.push({
      what,
      why: `it uses the ${type === 'sse' ? 'older SSE' : 'WebSocket'} transport, which Lumen does not support`
    })
    return null
  }
  if (raw.headersHelper !== undefined) {
    skipped.push({ what, why: 'it runs a command to make its headers' })
    return null
  }
  const notes: string[] = []
  const idBase = kebab(name, 20) || kebab(p.name, 20) || 'server'
  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return null
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === 'string')
      : []
    const all = [raw.command, ...args]
    if (all.some((s) => PLUGIN_VAR.test(s))) {
      skipped.push({
        what,
        why: 'it runs a program from inside the plugin, and Lumen does not copy programs'
      })
      return null
    }
    const cmd = expandDefaults(raw.command)
    const ex = args.map(expandDefaults)
    const missing = [...cmd.needs, ...ex.flatMap((e) => e.needs)]
    if (missing.length) {
      skipped.push({
        what,
        why: `its command needs values Lumen does not have (${[...new Set(missing)].join(', ')})`
      })
      return null
    }
    const env: Record<string, string> = {}
    const envNeeded: string[] = []
    const rawEnv =
      raw.env && typeof raw.env === 'object' ? (raw.env as Record<string, unknown>) : {}
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || typeof v !== 'string') continue
      if (PLUGIN_VAR.test(v)) {
        notes.push(`${k} pointed into the plugin folder and is left out`)
        continue
      }
      const e = expandDefaults(v)
      if (e.needs.length) envNeeded.push(k)
      else env[k] = e.text
    }
    if (envNeeded.length)
      notes.push(`set ${envNeeded.join(', ')} under the connector in Settings → Connectors`)
    const argList = ex.map((e) => e.text)
    return {
      idBase,
      input: {
        name: clip(name, 60),
        transport: 'stdio',
        command: cmd.text,
        args: argList,
        ...(Object.keys(env).length ? { env } : {})
      },
      preview: {
        key,
        name: clip(name, 60),
        plugin: p.name,
        transport: 'stdio',
        commandLine: commandLine(cmd.text, argList),
        envNeeded,
        tokenNeeded: false,
        notes
      }
    }
  }
  if (typeof raw.url !== 'string') return null
  const url = expandDefaults(raw.url)
  if (url.needs.length || PLUGIN_VAR.test(raw.url)) {
    skipped.push({ what, why: 'its address needs values Lumen does not have' })
    return null
  }
  let tokenNeeded = false
  const headers =
    raw.headers && typeof raw.headers === 'object' ? (raw.headers as Record<string, unknown>) : {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string' && /^bearer\s/i.test(v)) {
      tokenNeeded = true
      notes.push('paste its access token under the connector in Settings → Connectors')
    } else notes.push(`the "${k}" header is not sent (Lumen only sends an access token)`)
  }
  if (raw.oauth !== undefined) notes.push('click Sign in under the connector after adding it')
  return {
    idBase,
    input: { name: clip(name, 60), transport: 'http', url: url.text },
    preview: {
      key,
      name: clip(name, 60),
      plugin: p.name,
      transport: 'http',
      url: url.text,
      envNeeded: [],
      tokenNeeded,
      notes
    }
  }
}

/** Everything Lumen can take from one plugin. */
export function convertPlugin(files: readonly TreeFile[], p: FoundPlugin): ConvertedPlugin {
  const skills: ConvertedSkill[] = []
  const skipped: PluginSkipped[] = []
  const tryAdd = (what: string, fn: () => ConvertedSkill): void => {
    try {
      skills.push(fn())
    } catch (e) {
      skipped.push({ what, why: `it could not be read (${(e as Error).message.slice(0, 120)})` })
    }
  }
  for (const dir of skillDirs(files, p)) {
    const f = files.find((x) => x.name === `${dir}SKILL.md`)!
    const folder = dir.replace(/\/$/, '').split('/').pop() || p.name
    tryAdd(`skill "${folder}" (${p.name})`, () => {
      const extras = skillExtras(files, dir)
      const s = convertMd('skill', f.data.toString('utf8'), folder, p, extras.keep)
      s.preview.notes.push(...extras.notes)
      return s
    })
  }
  for (const c of commandSources(files, p))
    tryAdd(`command "/${c.name}" (${p.name})`, () => convertMd('command', c.text, c.name, p))
  for (const f of styleSources(files, p)) {
    const stem = f.name.split('/').pop()!.replace(/\.md$/i, '')
    tryAdd(`output style "${stem}" (${p.name})`, () =>
      convertMd('output-style', f.data.toString('utf8'), stem, p)
    )
  }

  const servers: OfferedServer[] = []
  const seenServers = new Set<string>()
  for (const map of serverMaps(files, p))
    for (const [name, raw] of Object.entries(map)) {
      if (!raw || typeof raw !== 'object' || seenServers.has(name)) continue
      seenServers.add(name)
      const s = offerServer(`${p.name}/${name}`, name, raw as Record<string, unknown>, p, skipped)
      if (s) servers.push(s)
    }
  for (const m of pathList(p.manifest.mcpServers))
    if (/\.(mcpb|dxt)$/i.test(m) || /^https:/i.test(m))
      skipped.push({
        what: `MCP bundle ${m.split('/').pop()} (${p.name})`,
        why: 'bundles hold programs; add the server from Settings → Connectors instead'
      })

  const has = (sub: string): boolean => files.some((f) => f.name.startsWith(`${p.prefix}${sub}`))
  if (has('hooks/') || p.manifest.hooks !== undefined)
    skipped.push({
      what: `hooks (${p.name})`,
      why: 'hooks run commands on your PC whenever Claude Code does something; Lumen never imports them'
    })
  if (has('agents/') || p.manifest.agents !== undefined)
    skipped.push({
      what: `subagents (${p.name})`,
      why: 'subagents are a Claude Code feature Lumen does not have'
    })
  for (const [k, label] of [
    ['lspServers', 'language servers'],
    ['workflows', 'workflows'],
    ['userConfig', 'settings it asks for'],
    ['channels', 'message channels']
  ] as const)
    if (
      p.manifest[k] !== undefined ||
      (k === 'lspServers' && has('.lsp.json')) ||
      (k === 'workflows' && has('workflows/'))
    )
      skipped.push({ what: `${label} (${p.name})`, why: 'not used by Lumen' })
  if (has('bin/') || has('scripts/'))
    skipped.push({
      what: `programs and scripts (${p.name})`,
      why: 'Lumen never imports programs or scripts'
    })
  return { skills, servers, skipped }
}
