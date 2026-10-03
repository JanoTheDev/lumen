// MCP client manager: one Client per enabled server, connected lazily (the first agent task
// that wants tools), reconnected with backoff after a failure or a dropped connection, and
// closed on quit. Calls time out after 30 s; long results are cut to 20k characters.
import type { Tool, Transport } from '@modelcontextprotocol/client'
import type { ConnectorServer } from '@shared/connectors'
import { LumenOAuthProvider, NeedsSignInError, signedIn, type OAuthStore } from './oauth'
import { launchProblem, type ServerSecrets } from './store'

export const CALL_TIMEOUT_MS = 30_000
export const CONNECT_TIMEOUT_MS = 15_000
export const MAX_RESULT_CHARS = 20_000
const BACKOFF_MS = [1_000, 5_000, 15_000, 60_000]
const STDERR_KEEP = 2_000

export interface McpTool {
  name: string
  description: string
  inputSchema: unknown
  readOnly: boolean
  destructive: boolean
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType: 'image/png' | 'image/jpeg' }

export interface McpCallResult {
  content: McpContent[]
  isError: boolean
}

/** What the manager needs from a connection (the SDK Client, or a fake in tests). */
export interface McpConnection {
  listTools(): Promise<McpTool[]>
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpCallResult>
  close(): Promise<void>
  /** Called once when the connection drops. */
  onClose(cb: () => void): void
}

export type Connect = (
  server: ConnectorServer,
  secrets: ServerSecrets,
  signal: AbortSignal,
  /** OAuth servers: where refreshed tokens are saved. */
  oauth?: OAuthStore
) => Promise<McpConnection>

export interface ServerState {
  state: 'off' | 'idle' | 'connected' | 'error'
  error?: string
  toolCount?: number
}

interface Entry {
  conn?: McpConnection
  pending?: Promise<McpConnection>
  tools?: McpTool[]
  failures: number
  retryAt: number
  error?: string
}

export interface ManagerDeps {
  servers(): ConnectorServer[]
  secrets(id: string): ServerSecrets
  /** The OAuth state of a server (auth: 'oauth'), kept with its secrets. */
  oauthStore?(id: string): OAuthStore
  connect?: Connect
  now?(): number
  log?(msg: string): void
}

export class McpManager {
  private entries = new Map<string, Entry>()
  private readonly connectFn: Connect
  private readonly now: () => number
  private readonly log: (m: string) => void

  constructor(private readonly deps: ManagerDeps) {
    this.connectFn = deps.connect ?? sdkConnect
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id)
    if (!e) {
      e = { failures: 0, retryAt: 0 }
      this.entries.set(id, e)
    }
    return e
  }

  state(server: ConnectorServer): ServerState {
    if (!server.enabled) return { state: 'off' }
    const e = this.entries.get(server.id)
    if (e?.conn) return { state: 'connected', toolCount: e.tools?.length }
    if (e?.error) return { state: 'error', error: e.error }
    return { state: 'idle' }
  }

  /** Connects (once; concurrent callers share the attempt). `force` skips the backoff wait. */
  async ensure(server: ConnectorServer, force = false): Promise<McpConnection> {
    const e = this.entry(server.id)
    if (e.conn) return e.conn
    if (e.pending) return e.pending
    if (!force && this.now() < e.retryAt) throw new Error(e.error ?? 'Waiting to reconnect.')
    const problem =
      launchProblem(server) ??
      (server.auth === 'oauth' &&
      !this.deps.secrets(server.id).bearer &&
      !signedIn(this.deps.secrets(server.id).oauth)
        ? new NeedsSignInError().message
        : null)
    if (problem) {
      e.error = problem
      throw new Error(problem)
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('Connecting timed out.')), CONNECT_TIMEOUT_MS)
    const attempt = this.connectFn(
      server,
      this.deps.secrets(server.id),
      ac.signal,
      this.deps.oauthStore?.(server.id)
    )
      .then(async (conn) => {
        let tools: McpTool[]
        try {
          tools = await withTimeout(conn.listTools(), CONNECT_TIMEOUT_MS, 'Listing tools')
        } catch (err) {
          // Connected but no tool list: close it, or each retry leaves a server process behind.
          void conn.close().catch(() => {})
          throw err
        }
        if (this.entries.get(server.id) !== e) {
          void conn.close().catch(() => {})
          throw new Error('Connector was removed.')
        }
        e.conn = conn
        e.tools = tools
        e.failures = 0
        e.retryAt = 0
        e.error = undefined
        conn.onClose(() => {
          if (e.conn !== conn) return
          e.conn = undefined
          e.tools = undefined
          this.fail(e, 'The connection closed.')
          this.log(`connector ${server.id}: connection closed`)
        })
        this.log(`connector ${server.id}: connected, ${tools.length} tools`)
        return conn
      })
      .catch((err: unknown) => {
        this.fail(e, errorText(err))
        this.log(`connector ${server.id}: ${e.error}`)
        throw new Error(e.error)
      })
      .finally(() => {
        clearTimeout(timer)
        e.pending = undefined
      })
    e.pending = attempt
    return attempt
  }

  private fail(e: Entry, error: string): void {
    e.error = error
    e.retryAt = this.now() + BACKOFF_MS[Math.min(e.failures, BACKOFF_MS.length - 1)]
    e.failures++
  }

  /** Tools of every enabled server that connects; failing servers are left out. */
  async allTools(): Promise<{ server: ConnectorServer; tools: McpTool[] }[]> {
    const servers = this.deps.servers().filter((s) => s.enabled)
    const out = await Promise.all(
      servers.map(async (server) => {
        try {
          await this.ensure(server)
          return { server, tools: this.entry(server.id).tools ?? [] }
        } catch {
          return null
        }
      })
    )
    return out.filter((x): x is { server: ConnectorServer; tools: McpTool[] } => !!x)
  }

  /** The cached tool list (connects first). */
  async tools(server: ConnectorServer, force = false): Promise<McpTool[]> {
    await this.ensure(server, force)
    return this.entry(server.id).tools ?? []
  }

  async call(
    server: ConnectorServer,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpCallResult> {
    const conn = await this.ensure(server)
    const r = await conn.callTool(tool, args, signal)
    return { ...r, content: truncate(r.content) }
  }

  /** Drops a server's connection (settings changed, removed, or quit). */
  async disconnect(id: string): Promise<void> {
    const e = this.entries.get(id)
    this.entries.delete(id)
    const conn = e?.conn
    if (conn) await conn.close().catch(() => {})
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.disconnect(id)))
  }
}

function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Could not connect.'
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out.`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** Cuts the text past MAX_RESULT_CHARS and says how much was left out. */
export function truncate(content: McpContent[], max = MAX_RESULT_CHARS): McpContent[] {
  let left = max
  const out: McpContent[] = []
  let cut = 0
  for (const c of content) {
    if (c.type !== 'text') {
      out.push(c)
      continue
    }
    if (left <= 0) {
      cut += c.text.length
      continue
    }
    if (c.text.length > left) {
      out.push({ type: 'text', text: c.text.slice(0, left) })
      cut += c.text.length - left
      left = 0
    } else {
      out.push(c)
      left -= c.text.length
    }
  }
  if (cut)
    out.push({
      type: 'text',
      text: `[Result shortened: ${cut} more characters were left out. Ask the tool for a smaller part if you need them.]`
    })
  return out
}

/** MCP content blocks → text and images the providers accept. */
export function contentOf(blocks: unknown): McpContent[] {
  const out: McpContent[] = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const c = b as Record<string, unknown>
    if (c.type === 'text' && typeof c.text === 'string') out.push({ type: 'text', text: c.text })
    else if (
      c.type === 'image' &&
      typeof c.data === 'string' &&
      (c.mimeType === 'image/png' || c.mimeType === 'image/jpeg')
    )
      out.push({ type: 'image', base64: c.data, mediaType: c.mimeType })
    else if (c.type === 'resource') {
      const r = (c.resource ?? {}) as Record<string, unknown>
      if (typeof r.text === 'string') out.push({ type: 'text', text: r.text })
      else out.push({ type: 'text', text: `[binary resource ${String(r.uri ?? '')} left out]` })
    } else if (c.type === 'resource_link')
      out.push({ type: 'text', text: `[resource link: ${String(c.uri ?? '')}]` })
    else out.push({ type: 'text', text: `[${String(c.type ?? 'unknown')} content left out]` })
  }
  return out
}

function toTool(t: Tool): McpTool {
  return {
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    readOnly: t.annotations?.readOnlyHint === true,
    destructive: t.annotations?.destructiveHint === true
  }
}

/** The real connection: @modelcontextprotocol/client over stdio or Streamable HTTP. */
export const sdkConnect: Connect = async (server, secrets, signal, oauth) => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
  const client = new Client({ name: 'lumen', version: '1.0.0' })
  let stderr = ''
  let transport: Transport
  if (server.transport === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
    const t = new StdioClientTransport({
      command: server.command ?? '',
      args: server.args ?? [],
      env: secrets.env ?? {},
      stderr: 'pipe'
    })
    t.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
    })
    transport = t
  } else if (server.auth === 'oauth' && oauth && !secrets.bearer) {
    // Tokens are refreshed by the SDK and saved back; a sign-in is never started from here.
    const port = oauth.load().port ?? 0
    transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
      authProvider: new LumenOAuthProvider({ store: oauth, port })
    })
  } else {
    transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
      requestInit: secrets.bearer ? { headers: { Authorization: `Bearer ${secrets.bearer}` } } : {}
    })
  }
  let closed: (() => void) | undefined
  client.onclose = () => closed?.()
  const onAbort = (): void => void client.close().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS })
  } catch (e) {
    const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ')
    const msg = errorText(e)
    const hint =
      server.transport === 'http' &&
      server.auth !== 'oauth' &&
      !secrets.bearer &&
      /\b401\b|unauthori[sz]ed/i.test(msg)
        ? ' If this server needs a sign-in, click Sign in under it in Settings → Connectors.'
        : ''
    throw new Error(`${msg}${tail ? ` (${tail.slice(0, 200)})` : ''}${hint}`)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return {
    async listTools() {
      const { tools } = await client.listTools()
      return tools.map(toTool)
    },
    async callTool(name, args, sig) {
      const r = await client.callTool(
        { name, arguments: args },
        {
          timeout: CALL_TIMEOUT_MS,
          maxTotalTimeout: CALL_TIMEOUT_MS,
          ...(sig ? { signal: sig } : {})
        }
      )
      return { content: contentOf(r.content), isError: r.isError === true }
    },
    close: () => client.close(),
    onClose(cb) {
      closed = cb
    }
  }
}
