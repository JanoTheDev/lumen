// A minimal obs-websocket v5 client (built into OBS 28+) on the runtime's WebSocket: Hello →
// Identify (with the password challenge when OBS asks) → Identified, then Request/Response.
// No event subscriptions; lesson checks only ask.
import { createHash } from 'crypto'

export const OBS_DEFAULT_PORT = 4455
const OP = { hello: 0, identify: 1, identified: 2, request: 6, response: 7 } as const
/** Close code OBS sends for a wrong password. */
const AUTH_FAILED = 4009

/** Errors the caller tells apart: no server, password needed, password wrong, timeout. */
export type ObsErrorCode = 'unreachable' | 'password-needed' | 'auth-failed' | 'timeout' | 'closed'

export class ObsError extends Error {
  constructor(
    readonly code: ObsErrorCode | 'request-failed',
    message?: string
  ) {
    super(message ?? code)
  }
}

/** obs-websocket v5 auth: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuth(password: string, salt: string, challenge: string): string {
  const b64 = (s: string): string => createHash('sha256').update(s).digest('base64')
  return b64(b64(password + salt) + challenge)
}

/** The subset of the WHATWG WebSocket the client uses (global in Node 22 / Electron main). */
export interface WsLike {
  readyState: number
  send(data: string): void
  close(code?: number): void
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number }) => void): void
}
export type WsFactory = (url: string, protocol: string) => WsLike

const defaultWs: WsFactory | null =
  typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
    ? (url, protocol) =>
        new (
          globalThis as unknown as { WebSocket: new (u: string, p: string) => WsLike }
        ).WebSocket(url, protocol)
    : null

export interface ObsConnection {
  request(type: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>
  close(): void
  readonly open: boolean
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function connectObs(opts: {
  port?: number
  password?: string
  timeoutMs?: number
  ws?: WsFactory
}): Promise<ObsConnection> {
  const make = opts.ws ?? defaultWs
  if (!make) return Promise.reject(new ObsError('unreachable', 'WebSocket is not available'))
  const timeoutMs = opts.timeoutMs ?? 3000
  const url = `ws://127.0.0.1:${opts.port ?? OBS_DEFAULT_PORT}`

  return new Promise((resolve, reject) => {
    let ws: WsLike
    try {
      ws = make(url, 'obsjson')
    } catch {
      return reject(new ObsError('unreachable'))
    }
    let identified = false
    let opened = false
    let closed = false
    let seq = 0
    const pending = new Map<string, Pending>()
    let failed = false
    const fail = (e: ObsError): void => {
      clearTimeout(timer)
      if (failed) return
      failed = true
      reject(e)
      try {
        ws.close()
      } catch {
        // Already closed.
      }
    }
    const timer = setTimeout(() => fail(new ObsError('timeout')), timeoutMs)

    const conn: ObsConnection = {
      get open() {
        return identified && !closed
      },
      close: () => {
        closed = true
        try {
          ws.close(1000)
        } catch {
          // Already closed.
        }
      },
      request: (type, data) =>
        new Promise((res, rej) => {
          if (!conn.open) return rej(new ObsError('closed'))
          const requestId = String(++seq)
          const t = setTimeout(() => {
            pending.delete(requestId)
            rej(new ObsError('timeout'))
          }, timeoutMs)
          pending.set(requestId, { resolve: res, reject: rej, timer: t })
          ws.send(
            JSON.stringify({
              op: OP.request,
              d: { requestType: type, requestId, ...(data ? { requestData: data } : {}) }
            })
          )
        })
    }

    ws.addEventListener('open', () => {
      opened = true
    })
    ws.addEventListener('error', () => {
      if (!identified) fail(new ObsError(opened ? 'closed' : 'unreachable'))
    })
    ws.addEventListener('close', (ev) => {
      closed = true
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new ObsError('closed'))
      }
      pending.clear()
      if (!identified)
        fail(
          new ObsError(ev.code === AUTH_FAILED ? 'auth-failed' : opened ? 'closed' : 'unreachable')
        )
    })
    ws.addEventListener('message', (ev) => {
      let msg: { op?: number; d?: Record<string, unknown> }
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg
      } catch {
        return
      }
      const d = msg.d ?? {}
      if (msg.op === OP.hello) {
        const auth = d.authentication as { challenge?: string; salt?: string } | undefined
        if (auth && !opts.password) return fail(new ObsError('password-needed'))
        ws.send(
          JSON.stringify({
            op: OP.identify,
            d: {
              rpcVersion: 1,
              eventSubscriptions: 0,
              ...(auth
                ? { authentication: obsAuth(opts.password!, auth.salt ?? '', auth.challenge ?? '') }
                : {})
            }
          })
        )
      } else if (msg.op === OP.identified) {
        identified = true
        clearTimeout(timer)
        resolve(conn)
      } else if (msg.op === OP.response) {
        const p = pending.get(String(d.requestId))
        if (!p) return
        pending.delete(String(d.requestId))
        clearTimeout(p.timer)
        const status = d.requestStatus as { result?: boolean; comment?: string } | undefined
        if (status?.result) p.resolve((d.responseData as Record<string, unknown>) ?? {})
        else p.reject(new ObsError('request-failed', status?.comment ?? 'request failed'))
      }
    })
  })
}
