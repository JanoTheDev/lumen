// Connector settings: ~/.ai-overlay/connectors.json holds the servers without secrets;
// bearer tokens and environment values are encrypted with Windows DPAPI (Electron
// safeStorage) in connectors.dat beside it, like the bridge passwords in bridges.dat.
// Without encryption, secrets live in memory until Lumen closes.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { commandLine, type ConnectorInput, type ConnectorServer } from '@shared/connectors'

export { commandLine }

export const SERVER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const TOOL_NAME_RE = /^[\w.\-/ ]{1,128}$/

const policySchema = z.enum(['ask', 'allow', 'deny'])

export const serverSchema = z
  .object({
    id: z.string().regex(SERVER_ID_RE),
    name: z.string().trim().min(1).max(60),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(1000)).max(40).optional(),
    envNames: z.array(z.string().regex(ENV_NAME_RE)).max(30).optional(),
    url: z.string().max(2000).optional(),
    enabled: z.boolean(),
    trusted: z.boolean().optional(),
    toolPolicy: z.record(z.string().regex(TOOL_NAME_RE), policySchema)
  })
  .strict()

const fileSchema = z.object({ servers: z.array(z.unknown()) })

export const inputSchema = z
  .object({
    id: z.string().regex(SERVER_ID_RE),
    name: z.string().trim().min(1).max(60),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(1000)).max(40).optional(),
    url: z.string().trim().max(2000).optional(),
    enabled: z.boolean().optional(),
    trustCommand: z.boolean().optional(),
    bearer: z.string().max(4000).optional(),
    env: z.record(z.string().regex(ENV_NAME_RE), z.string().max(4000)).optional(),
    toolPolicy: z.record(z.string().regex(TOOL_NAME_RE), policySchema).optional()
  })
  .strict()

/** https anywhere, http only on this PC. */
export function urlProblem(raw: string | undefined): string | null {
  if (!raw) return 'Enter the server URL.'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'That is not a valid URL.'
  }
  if (u.username || u.password) return 'Put credentials in the token field, not the URL.'
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return null
  return 'Use an https:// URL (http:// only for localhost).'
}

export interface Cipher {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export interface ServerSecrets {
  bearer?: string
  env?: Record<string, string>
}

/** Secrets per server id, encrypted at rest. */
export class ConnectorSecrets {
  private data: Record<string, ServerSecrets> = {}

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {
    if (!existsSync(file) || !cipher.available()) return
    try {
      const v = JSON.parse(cipher.decrypt(readFileSync(file))) as unknown
      if (v && typeof v === 'object') this.data = v as Record<string, ServerSecrets>
    } catch {
      this.data = {}
    }
  }

  get(id: string): ServerSecrets {
    return this.data[id] ?? {}
  }

  /** bearer: undefined keeps, '' removes. env: a '' value removes that variable. */
  set(id: string, bearer: string | undefined, env: Record<string, string> | undefined): boolean {
    const cur = { ...this.get(id), env: { ...this.get(id).env } }
    if (bearer !== undefined) {
      if (bearer) cur.bearer = bearer
      else delete cur.bearer
    }
    for (const [k, v] of Object.entries(env ?? {})) {
      if (v) cur.env[k] = v
      else delete cur.env[k]
    }
    const next: ServerSecrets = {
      ...(cur.bearer ? { bearer: cur.bearer } : {}),
      ...(Object.keys(cur.env).length ? { env: cur.env } : {})
    }
    if (Object.keys(next).length) this.data[id] = next
    else delete this.data[id]
    return this.save()
  }

  remove(id: string): boolean {
    delete this.data[id]
    return this.save()
  }

  private save(): boolean {
    if (!this.cipher.available()) return false
    try {
      if (!Object.keys(this.data).length) {
        rmSync(this.file, { force: true })
        return true
      }
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, this.cipher.encrypt(JSON.stringify(this.data)))
      return true
    } catch {
      return false
    }
  }
}

/** Reads connectors.json; bad entries are skipped (and reported), never fatal. */
export function readServers(file: string, warn: (m: string) => void = () => {}): ConnectorServer[] {
  if (!existsSync(file)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    warn(`connectors.json unreadable: ${(e as Error).message}`)
    return []
  }
  const top = fileSchema.safeParse(raw)
  if (!top.success) {
    warn('connectors.json has no servers list')
    return []
  }
  const out: ConnectorServer[] = []
  const seen = new Set<string>()
  for (const s of top.data.servers) {
    const r = serverSchema.safeParse(s)
    if (!r.success || seen.has(r.data.id)) {
      warn(`connectors.json: skipped an invalid or duplicate server`)
      continue
    }
    seen.add(r.data.id)
    out.push(r.data)
  }
  return out
}

export function writeServers(file: string, servers: readonly ConnectorServer[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ servers }, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

export type Applied = { ok: true; server: ConnectorServer } | { ok: false; error: string }

/**
 * Merges an add/update request into the stored server. A stdio server needs the user's
 * explicit trust for its exact command line; changing the command or args asks again.
 */
export function applyInput(input: ConnectorInput, prev: ConnectorServer | undefined): Applied {
  const base = {
    id: input.id,
    name: input.name.trim(),
    enabled: input.enabled ?? prev?.enabled ?? true,
    toolPolicy: input.toolPolicy ?? prev?.toolPolicy ?? {}
  }
  const envNames = (prevNames: string[] = []): string[] => {
    const names = new Set(prevNames)
    for (const [k, v] of Object.entries(input.env ?? {})) {
      if (v) names.add(k)
      else names.delete(k)
    }
    return [...names].sort()
  }
  if (input.transport === 'http') {
    const problem = urlProblem(input.url)
    if (problem) return { ok: false, error: problem }
    return { ok: true, server: { ...base, transport: 'http', url: input.url } }
  }
  if (!input.command) return { ok: false, error: 'Enter the command that starts the server.' }
  const args = input.args ?? []
  const same =
    prev?.transport === 'stdio' &&
    prev.trusted === true &&
    commandLine(prev.command, prev.args) === commandLine(input.command, args)
  if (!same && input.trustCommand !== true)
    return { ok: false, error: 'Tick “I trust this command” to run it.' }
  const names = envNames(prev?.transport === 'stdio' ? prev.envNames : [])
  return {
    ok: true,
    server: {
      ...base,
      transport: 'stdio',
      command: input.command,
      args,
      ...(names.length ? { envNames: names } : {}),
      trusted: true
    }
  }
}
