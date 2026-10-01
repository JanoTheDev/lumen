// OAuth sign-in for web connectors (MCP authorization: OAuth 2.1 authorization code + PKCE,
// dynamic client registration). The SDK (@modelcontextprotocol/client `auth`) does discovery,
// registration, PKCE and the token exchange; this file is the OAuthClientProvider that keeps
// the client registration and tokens with the connector's other secrets (DPAPI-encrypted in
// connectors.dat), and the one-shot loopback listener on 127.0.0.1 that receives the browser
// redirect. Tokens, codes and verifiers are never logged. The PKCE verifier and the state
// value live in memory only, for one sign-in.
import { randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import {
  auth,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens
} from '@modelcontextprotocol/client'

/** What is kept per connector (JSON, encrypted with the other secrets). */
export interface OAuthState {
  client?: unknown
  tokens?: unknown
  discovery?: unknown
  /** The loopback port the client was registered with (its redirect URI). */
  port?: number
}

export interface OAuthStore {
  load(): OAuthState
  save(next: OAuthState): void
}

export const CALLBACK_PATH = '/callback'
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export const redirectUrlFor = (port: number): string => `http://127.0.0.1:${port}${CALLBACK_PATH}`

export class NeedsSignInError extends Error {
  constructor() {
    super('Not signed in. Open Settings → Connectors and click Sign in.')
  }
}

export interface ProviderOptions {
  store: OAuthStore
  port: number
  /** Interactive sign-in: opens the authorization page. Absent = connecting, never prompts. */
  open?: (url: URL) => void | Promise<void>
  state?: string
}

/** The SDK's OAuthClientProvider over a connector's stored OAuth state. */
export class LumenOAuthProvider implements OAuthClientProvider {
  private verifier: string | null = null

  constructor(private readonly opts: ProviderOptions) {}

  get redirectUrl(): string {
    return redirectUrlFor(this.opts.port)
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Lumen',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    return this.opts.state ?? randomBytes(16).toString('hex')
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.opts.store.load().client as StoredOAuthClientInformation | undefined
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.opts.store.save({ ...this.opts.store.load(), client: info, port: this.opts.port })
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.opts.store.load().tokens as StoredOAuthTokens | undefined
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.opts.store.save({ ...this.opts.store.load(), tokens })
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.open) throw new NeedsSignInError()
    if (url.protocol !== 'https:' && !isLoopback(url))
      throw new Error('The sign-in page is not an https:// address.')
    await this.opts.open(url)
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No sign-in is in progress.')
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.opts.store.save({ ...this.opts.store.load(), discovery: state })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.opts.store.load().discovery as OAuthDiscoveryState | undefined
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this.verifier = null
      return
    }
    const cur = { ...this.opts.store.load() }
    if (scope === 'all') {
      this.opts.store.save({})
      return
    }
    if (scope === 'client') delete cur.client
    if (scope === 'tokens') delete cur.tokens
    if (scope === 'discovery') delete cur.discovery
    this.opts.store.save(cur)
  }
}

function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)
}

export interface CallbackResult {
  code: string
  iss?: string
}

const PAGE = (msg: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Lumen</title></head><body style="font:16px system-ui;margin:3em"><p>${msg}</p></body></html>`

export interface Loopback {
  port: number
  /** Resolves with the code once the browser comes back with the right state. */
  wait(state: string, signal: AbortSignal): Promise<CallbackResult>
  close(): void
}

/** A one-shot listener on 127.0.0.1 (the saved port when free, else any free port). */
export function listenLoopback(preferred?: number): Promise<Loopback> {
  const start = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const srv = createServer()
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => resolve(srv))
    })
  return (async () => {
    let srv: Server
    try {
      srv = await start(preferred ?? 0)
    } catch {
      srv = await start(0)
    }
    const port = (srv.address() as AddressInfo).port
    let handler: ((u: URL) => string) | null = null
    srv.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH || !handler) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
        return
      }
      const msg = handler(u)
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
        })
        .end(PAGE(msg))
    })
    return {
      port,
      wait(state, signal) {
        return new Promise<CallbackResult>((resolve, reject) => {
          const fail = (e: Error): void => {
            handler = null
            reject(e)
          }
          if (signal.aborted) return fail(new Error('Sign-in cancelled.'))
          signal.addEventListener('abort', () => fail(new Error('Sign-in timed out.')), {
            once: true
          })
          handler = (u) => {
            if (u.searchParams.get('state') !== state)
              return 'This sign-in link does not match. Start again from Lumen.'
            const error = u.searchParams.get('error')
            const code = u.searchParams.get('code')
            handler = null
            if (error || !code) {
              reject(
                new Error(`The sign-in was not completed (${(error ?? 'no code').slice(0, 60)}).`)
              )
              return 'The sign-in was not completed. You can close this tab.'
            }
            const iss = u.searchParams.get('iss')
            resolve({ code, ...(iss ? { iss } : {}) })
            return 'Signed in. You can close this tab and go back to Lumen.'
          }
        })
      },
      close: () => void srv.close()
    }
  })()
}

export interface SignInDeps {
  open(url: URL): void | Promise<void>
  /** The SDK's auth(); a fake in tests. */
  authFn?: typeof auth
  listen?: typeof listenLoopback
  timeoutMs?: number
  fetchFn?: Parameters<typeof auth>[1]['fetchFn']
  /** Aborts the sign-in (the connector was edited or removed, or another sign-in started). */
  signal?: AbortSignal
}

type FetchLike = NonNullable<SignInDeps['fetchFn']>

/** Rejects when the signal aborts; the work itself is left to settle. */
function raced<T>(p: Promise<T>, signal: AbortSignal, why: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error(why()))
    const onAbort = (): void => reject(new Error(why()))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Interactive sign-in: drops old tokens, registers (or reuses the registration when the port is
 * the same), opens the browser and exchanges the code. Resolves when tokens are stored.
 */
export async function signIn(
  serverUrl: string,
  store: OAuthStore,
  deps: SignInDeps
): Promise<void> {
  const authFn = deps.authFn ?? auth
  const loop = await (deps.listen ?? listenLoopback)(store.load().port)
  try {
    const prev = store.load()
    // A registration is bound to its redirect URI: another port needs a new one.
    const next: OAuthState = prev.port === loop.port ? { ...prev } : { port: loop.port }
    delete next.tokens
    store.save({ ...next, port: loop.port })
    const state = randomBytes(16).toString('hex')
    const provider = new LumenOAuthProvider({ store, port: loop.port, open: deps.open, state })
    // One limit for the whole sign-in: discovery, registration and the token exchange too.
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
    const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout
    const why = (): string => (deps.signal?.aborted ? 'Sign-in cancelled.' : 'Sign-in timed out.')
    const base: FetchLike = deps.fetchFn ?? ((url, init) => fetch(url, init))
    const fetchFn: FetchLike = (url, init) =>
      base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
    const opts = { serverUrl, fetchFn }
    // Listening before the browser opens, so a fast redirect is not missed.
    const pending = loop.wait(state, signal)
    pending.catch(() => {})
    const first = await raced(authFn(provider, opts), signal, why)
    if (first === 'AUTHORIZED') return
    const cb = await raced(pending, signal, why)
    const done = await raced(
      authFn(provider, { ...opts, authorizationCode: cb.code, iss: cb.iss }),
      signal,
      why
    )
    if (done !== 'AUTHORIZED') throw new Error('The server did not accept the sign-in.')
  } finally {
    loop.close()
  }
}

/** Signed in = tokens are stored (they may still need a refresh). */
export function signedIn(state: OAuthState | undefined): boolean {
  return !!state?.tokens
}
