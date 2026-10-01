// Connectors (MCP servers): settings in connectors.json + connectors.dat, one McpManager for
// the app, the Settings operations behind connectors:* and the tool set for agent tasks.
import { dirname, join } from 'path'
import { safeStorage } from 'electron'
import type {
  ConnectorInput,
  ConnectorResult,
  ConnectorServer,
  ConnectorTestResult,
  ConnectorToolInfo,
  ConnectorView
} from '@shared/connectors'
import type { ToolDef } from '../ai/providers/types'
import { gate } from '../actions/policy'
import type { ToolHandler } from '../agent-mode/runner'
import { configPath } from '../config'
import { log } from '../logger'
import { McpManager, type ManagerDeps } from './mcp'
import { signIn, signedIn, type OAuthStore, type SignInDeps } from './oauth'
import {
  applyInput,
  commandLine,
  ConnectorSecrets,
  readServers,
  writeServers,
  type Cipher
} from './store'
import {
  createMcpToolHandlers,
  DEFAULT_OPTIONAL_BUDGET,
  mcpToolDefs,
  type McpHandlerDeps,
  type McpTaskEnv
} from './tools'

const safeCipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (t) => safeStorage.encryptString(t),
  decrypt: (d) => safeStorage.decryptString(d)
}

export interface ConnectorsOptions {
  file: string
  secretsFile: string
  cipher: Cipher
  connect?: ManagerDeps['connect']
}

/** Settings + connections. One per app; tests make their own. */
export class Connectors {
  private servers: ConnectorServer[]
  readonly secrets: ConnectorSecrets
  readonly manager: McpManager

  constructor(private readonly opts: ConnectorsOptions) {
    this.servers = readServers(opts.file, (m) => log('fail', m))
    this.secrets = new ConnectorSecrets(opts.secretsFile, opts.cipher)
    this.manager = new McpManager({
      servers: () => this.servers,
      secrets: (id) => this.secrets.get(id),
      oauthStore: (id) => this.oauthStore(id),
      ...(opts.connect ? { connect: opts.connect } : {}),
      log: (m) => log('step', m)
    })
  }

  get(id: string): ConnectorServer | undefined {
    return this.servers.find((s) => s.id === id)
  }

  list(): ConnectorView[] {
    return this.servers.map((s) => ({
      ...s,
      hasBearer: !!this.secrets.get(s.id).bearer,
      ...(s.auth === 'oauth' ? { signedIn: signedIn(this.secrets.get(s.id).oauth) } : {}),
      ...(s.transport === 'stdio' ? { commandLine: commandLine(s.command, s.args) } : {}),
      ...this.manager.state(s)
    }))
  }

  private save(): void {
    writeServers(this.opts.file, this.servers)
  }

  add(input: ConnectorInput): ConnectorResult {
    if (this.get(input.id)) return { ok: false, error: 'A connector with this id already exists.' }
    return this.put(input, undefined)
  }

  update(input: ConnectorInput): ConnectorResult {
    const prev = this.get(input.id)
    if (!prev) return { ok: false, error: 'No connector with this id.' }
    return this.put(input, prev)
  }

  private put(input: ConnectorInput, prev: ConnectorServer | undefined): ConnectorResult {
    const r = applyInput(input, prev)
    if (!r.ok) return r
    if (r.server.transport === 'http') {
      // Switching from stdio drops that command's environment values.
      const drop = Object.fromEntries((prev?.envNames ?? []).map((n) => [n, '']))
      this.secrets.set(r.server.id, input.bearer, drop)
    } else this.secrets.set(r.server.id, '', input.env)
    // A sign-in belongs to one server address.
    if (r.server.auth !== 'oauth' || (prev && prev.url !== r.server.url))
      this.secrets.setOAuth(r.server.id, undefined)
    this.servers = prev
      ? this.servers.map((s) => (s.id === prev.id ? r.server : s))
      : [...this.servers, r.server]
    this.save()
    void this.manager.disconnect(r.server.id)
    return { ok: true }
  }

  async remove(id: string): Promise<ConnectorResult> {
    if (!this.get(id)) return { ok: false, error: 'No connector with this id.' }
    this.servers = this.servers.filter((s) => s.id !== id)
    this.save()
    this.secrets.remove(id)
    await this.manager.disconnect(id)
    return { ok: true }
  }

  /** The stored OAuth state of a server, saved back encrypted. */
  oauthStore(id: string): OAuthStore {
    return {
      load: () => this.secrets.get(id).oauth ?? {},
      save: (next) => void this.secrets.setOAuth(id, next)
    }
  }

  /** Browser sign-in for an OAuth web connector; the next connection uses the new tokens. */
  async signIn(id: string, deps: SignInDeps): Promise<ConnectorResult> {
    const s = this.get(id)
    if (!s || s.transport !== 'http') return { ok: false, error: 'Only web connectors sign in.' }
    try {
      await signIn(s.url ?? '', this.oauthStore(id), deps)
      // From now on this server connects with its OAuth tokens.
      if (s.auth !== 'oauth') {
        this.servers = this.servers.map((x) => (x.id === id ? { ...x, auth: 'oauth' as const } : x))
        this.save()
      }
      await this.manager.disconnect(id)
      log('done', `connector ${id}: signed in`)
      return { ok: true }
    } catch (e) {
      const msg = (e as Error).message.replace(/\s+/g, ' ').slice(0, 300)
      log('fail', `connector ${id}: sign-in failed: ${msg}`)
      return { ok: false, error: msg || 'The sign-in failed.' }
    }
  }

  async signOut(id: string): Promise<ConnectorResult> {
    if (!this.get(id)) return { ok: false, error: 'No connector with this id.' }
    this.secrets.setOAuth(id, undefined)
    await this.manager.disconnect(id)
    return { ok: true }
  }

  /** Connects now (no backoff wait) and reports the tool count or the error. */
  async test(id: string): Promise<ConnectorTestResult> {
    const s = this.get(id)
    if (!s) return { ok: false, error: 'No connector with this id.' }
    await this.manager.disconnect(id)
    try {
      const tools = await this.manager.tools({ ...s, enabled: true }, true)
      if (!s.enabled) await this.manager.disconnect(id)
      return { ok: true, toolCount: tools.length }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async tools(id: string): Promise<ConnectorToolInfo[] | { error: string }> {
    const s = this.get(id)
    if (!s) return { error: 'No connector with this id.' }
    try {
      const tools = await this.manager.tools({ ...s, enabled: true }, true)
      return tools.map((t) => ({
        name: t.name,
        description: t.description.slice(0, 300),
        readOnly: t.readOnly,
        destructive: t.destructive,
        policy: s.toolPolicy[t.name] ?? 'default'
      }))
    } catch (e) {
      return { error: (e as Error).message }
    }
  }

  /**
   * Tool definitions and handlers for one agent task. Connects enabled servers on first use;
   * servers that fail are skipped. Empty when no connector is set up.
   */
  async toolSet(
    env: McpTaskEnv,
    opts: { optionalBudget?: number; deps?: Partial<McpHandlerDeps> } = {}
  ): Promise<{ defs: ToolDef[]; handlers: Record<string, ToolHandler> }> {
    if (!this.servers.some((s) => s.enabled)) return { defs: [], handlers: {} }
    const list = await this.manager.allTools()
    const entries = mcpToolDefs(list, opts.optionalBudget ?? DEFAULT_OPTIONAL_BUDGET)
    const handlers = createMcpToolHandlers(entries, env, {
      manager: this.manager,
      gate,
      ...opts.deps
    })
    return { defs: entries.map((e) => e.def), handlers }
  }
}

let instance: Connectors | null = null

/** The app's connectors (created on first use; DPAPI needs the app to be ready). */
export function connectors(): Connectors {
  if (!instance) {
    const dir = dirname(configPath())
    instance = new Connectors({
      file: join(dir, 'connectors.json'),
      secretsFile: join(dir, 'connectors.dat'),
      cipher: safeCipher
    })
  }
  return instance
}

/** MCP tools for an agent task (08 T18): `{defs, handlers}` to merge into the run. */
export function mcpToolSet(
  env: McpTaskEnv,
  opts?: { optionalBudget?: number }
): Promise<{ defs: ToolDef[]; handlers: Record<string, ToolHandler> }> {
  return connectors().toolSet(env, opts)
}

/** Closes every server connection (quit). */
export async function shutdownConnectors(): Promise<void> {
  await instance?.manager.closeAll()
}
