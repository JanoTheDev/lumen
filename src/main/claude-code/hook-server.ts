// Lumen's localhost endpoint for Claude Code http hooks (08 T35/T38). 127.0.0.1 only, a
// per-install token in a header, POST JSON only, no browser origins, a body cap. Paths:
//   /lumen-hook/s/<cc id>/<Event>  hooks passed per session with --settings
//   /lumen-hook/g/<Event>          the opt-in global hooks in ~/.claude/settings.json
// A handler error answers `{}` ("no opinion"): the CLI then falls back to its own behavior.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'

export const MAX_BODY = 1024 * 1024
export const HOOK_EVENTS = [
  'PermissionRequest',
  'PreToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd'
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookCall {
  scope: 'session' | 'global'
  /** The Lumen session id (scope session). */
  sessionKey?: string
  event: HookEvent
  payload: Record<string, unknown>
  /** Aborted when the CLI hangs up (turn interrupted, timeout). */
  signal: AbortSignal
}

export type HookHandler = (call: HookCall) => Promise<Record<string, unknown>>

const PATH_RE = /^\/lumen-hook\/(?:s\/(cc_[a-z0-9]{4,40})|g)\/([A-Za-z]+)$/

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class HookServer {
  private server: Server | null = null
  private boundPort = 0

  constructor(
    private readonly token: string,
    private readonly handler: HookHandler,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  get port(): number {
    return this.boundPort
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.boundPort}${path}`
  }

  /** Listens on `preferred` (the port global hooks were installed with), else any free port. */
  async start(preferred = 0): Promise<number> {
    if (this.server) return this.boundPort
    const listen = (port: number): Promise<Server> =>
      new Promise((resolve, reject) => {
        const s = createServer((req, res) => void this.onRequest(req, res))
        s.once('error', reject)
        s.listen(port, '127.0.0.1', () => {
          s.off('error', reject)
          resolve(s)
        })
      })
    try {
      this.server = await listen(preferred)
    } catch (e) {
      if (!preferred) throw e
      this.log(`hook port ${preferred} busy (${(e as Error).message}); using a free one`)
      this.server = await listen(0)
    }
    const addr = this.server.address()
    this.boundPort = typeof addr === 'object' && addr ? addr.port : 0
    return this.boundPort
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.boundPort = 0
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: Record<string, unknown> = {}): void => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const m = PATH_RE.exec(req.url ?? '')
    const host = String(req.headers.host ?? '')
    if (
      req.method !== 'POST' ||
      !m ||
      // Browsers send Origin on cross-site requests; DNS rebinding changes Host.
      req.headers.origin !== undefined ||
      !/^(127\.0\.0\.1|localhost):\d+$/.test(host)
    )
      return reply(404)
    const token = req.headers['x-lumen-token']
    if (typeof token !== 'string' || !sameToken(token, this.token)) return reply(403)
    const event = m[2] as HookEvent
    if (!HOOK_EVENTS.includes(event)) return reply(404)

    let size = 0
    const chunks: Buffer[] = []
    let tooBig = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        tooBig = true
        req.destroy()
      } else chunks.push(c)
    })
    await new Promise<void>((resolve) => {
      req.on('end', resolve)
      req.on('close', resolve)
    })
    if (tooBig) return reply(413)
    let payload: Record<string, unknown>
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reply(400)
      payload = v as Record<string, unknown>
    } catch {
      return reply(400)
    }
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    try {
      const out = await this.handler({
        scope: m[1] ? 'session' : 'global',
        ...(m[1] ? { sessionKey: m[1] } : {}),
        event,
        payload,
        signal: ac.signal
      })
      reply(200, out)
    } catch (e) {
      this.log(`hook ${event} failed: ${(e as Error).message}`)
      reply(200, {})
    }
  }
}
