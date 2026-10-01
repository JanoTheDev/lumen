// Blender bridge client (07 T23): NDJSON over TCP to the Lumen Bridge add-on on
// 127.0.0.1:47651, one short connection per question. The add-on only answers requests
// carrying the token Lumen keeps in <userData>/blender-bridge.token.
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createConnection, type Socket } from 'net'
import { dirname } from 'path'
import type { BridgeStatus } from '@shared/channels'
import type { BridgeState } from './expect'
import type { AppBridge } from './types'

export const BLENDER_PORT = 47651
export const BLENDER_HOST = '127.0.0.1'
const TIMEOUT_MS = 2500
const MAX_REPLY = 256 * 1024

/** The token the add-on must echo; made once and kept so a running add-on stays valid. */
export function ensureToken(file: string): string {
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{64}$/.test(t)) return t
    }
  } catch {
    // Unreadable: write a new one.
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

export interface BlenderReply {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

export type Connect = (port: number, host: string) => Socket

export class BlenderClient {
  private seq = 0

  constructor(
    private readonly token: () => string,
    private readonly opts: { port?: number; connect?: Connect; timeoutMs?: number } = {}
  ) {}

  /** One request; rejects with the socket error code (ECONNREFUSED …) or 'timeout'. */
  request(
    cmd: 'ping' | 'state' | 'object',
    extra: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<BlenderReply> {
    const port = this.opts.port ?? BLENDER_PORT
    const connect = this.opts.connect ?? ((p, h) => createConnection({ port: p, host: h }))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const sock = connect(port, BLENDER_HOST)
      let buf = ''
      const done = (err: Error | null, reply?: BlenderReply): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        sock.destroy()
        if (err) reject(err)
        else resolve(reply!)
      }
      const onAbort = (): void => done(new Error('aborted'))
      const timer = setTimeout(() => done(new Error('timeout')), this.opts.timeoutMs ?? TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      sock.setEncoding('utf8')
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id, cmd, token: this.token(), ...extra }) + '\n')
      })
      sock.on('data', (chunk: string) => {
        buf += chunk
        if (buf.length > MAX_REPLY) return done(new Error('reply too long'))
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        try {
          const msg = JSON.parse(buf.slice(0, nl)) as BlenderReply & { id?: unknown }
          done(null, { ok: msg.ok === true, result: msg.result, error: msg.error })
        } catch {
          done(new Error('bad reply'))
        }
      })
      sock.on('error', (e: NodeJS.ErrnoException) => done(new Error(e.code ?? e.message)))
      sock.on('close', () => done(new Error('closed')))
    })
  }
}

export function blenderBridge(client: BlenderClient): AppBridge {
  return {
    id: 'blender',
    name: 'Blender',
    async state(_question, signal): Promise<BridgeState | null> {
      const r = await client.request('state', {}, signal).catch(() => null)
      return r?.ok && r.result ? r.result : null
    },
    async status(): Promise<BridgeStatus> {
      const base = { id: 'blender', name: 'Blender' } as const
      try {
        const r = await client.request('ping')
        if (r.ok) {
          const v = r.result?.bridge
          return { ...base, state: 'connected', ...(typeof v === 'string' ? { version: v } : {}) }
        }
        return {
          ...base,
          state: 'error',
          detail:
            r.error === 'unauthorized'
              ? 'The add-on did not accept Lumen’s token. Restart Blender, then test again.'
              : `The add-on answered: ${r.error ?? 'error'}.`
        }
      } catch (e) {
        const code = (e as Error).message
        return {
          ...base,
          state: 'absent',
          detail:
            code === 'ECONNREFUSED'
              ? 'Blender is closed, or the Lumen Bridge add-on is not on.'
              : `No answer from Blender (${code}).`
        }
      }
    }
  }
}
