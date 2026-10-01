// OAuth sign-in: the provider keeps registration, tokens and discovery in the store (the
// verifier in memory only), the loopback listener only accepts the matching state, and a
// sign-in exchanges the code it received. The SDK's auth() is faked; the listener is real
// (127.0.0.1 only).
import { request } from 'http'
import { describe, expect, it, vi } from 'vitest'
import {
  LumenOAuthProvider,
  NeedsSignInError,
  listenLoopback,
  redirectUrlFor,
  signIn,
  type Loopback,
  type OAuthState,
  type OAuthStore
} from '../../src/main/connectors/oauth'

type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>

function memStore(init: OAuthState = {}): OAuthStore & { state: OAuthState } {
  const s = {
    state: init,
    load: () => s.state,
    save: (next: OAuthState) => {
      s.state = next
    }
  }
  return s
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })
}

describe('LumenOAuthProvider', () => {
  it('stores client, tokens and discovery; keeps the verifier in memory', () => {
    const store = memStore()
    const p = new LumenOAuthProvider({ store, port: 4321 })
    expect(p.redirectUrl).toBe('http://127.0.0.1:4321/callback')
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ['http://127.0.0.1:4321/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token']
    })
    p.saveClientInformation({ client_id: 'c1' } as never)
    p.saveTokens({ access_token: 'a', token_type: 'Bearer' } as never)
    p.saveCodeVerifier('v')
    expect(store.state).toMatchObject({
      client: { client_id: 'c1' },
      port: 4321,
      tokens: { access_token: 'a' }
    })
    expect(JSON.stringify(store.state)).not.toContain('"v"')
    expect(p.codeVerifier()).toBe('v')
    p.invalidateCredentials('tokens')
    expect(store.state.tokens).toBeUndefined()
    expect(store.state.client).toBeDefined()
    p.invalidateCredentials('all')
    expect(store.state).toEqual({})
  })

  it('never starts a sign-in while connecting; refuses non-https sign-in pages', async () => {
    const p = new LumenOAuthProvider({ store: memStore(), port: 1 })
    await expect(
      p.redirectToAuthorization(new URL('https://as.example.com/a'))
    ).rejects.toBeInstanceOf(NeedsSignInError)
    const open = vi.fn()
    const q = new LumenOAuthProvider({ store: memStore(), port: 1, open })
    await expect(q.redirectToAuthorization(new URL('http://evil.example.com/a'))).rejects.toThrow(
      /https/
    )
    await q.redirectToAuthorization(new URL('https://as.example.com/a'))
    expect(open).toHaveBeenCalledOnce()
  })
})

describe('loopback listener', () => {
  it('answers only the callback with the matching state', async () => {
    const loop = await listenLoopback()
    try {
      const ac = new AbortController()
      const wait = loop.wait('s1', ac.signal)
      const base = redirectUrlFor(loop.port)
      expect((await get(`http://127.0.0.1:${loop.port}/other`)).status).toBe(404)
      const wrong = await get(`${base}?code=c&state=bad`)
      expect(wrong.body).toMatch(/does not match/)
      const ok = await get(`${base}?code=the-code&state=s1&iss=https%3A%2F%2Fas.example.com`)
      expect(ok.body).toMatch(/Signed in/)
      expect(ok.body).not.toContain('the-code')
      await expect(wait).resolves.toEqual({ code: 'the-code', iss: 'https://as.example.com' })
    } finally {
      loop.close()
    }
  })

  it('reports a refused sign-in', async () => {
    const loop = await listenLoopback()
    try {
      const wait = loop.wait('s', new AbortController().signal)
      wait.catch(() => {})
      await get(`${redirectUrlFor(loop.port)}?error=access_denied&state=s`)
      await expect(wait).rejects.toThrow(/access_denied/)
    } finally {
      loop.close()
    }
  })
})

describe('signIn', () => {
  it('opens the page, waits for the redirect and exchanges the code', async () => {
    // The saved port is busy, so the registration made for it cannot be reused.
    const busy = await listenLoopback()
    const store = memStore({ tokens: { old: true }, client: { client_id: 'old' }, port: busy.port })
    const calls: { code?: string }[] = []
    const authFn = vi.fn(
      async (provider: LumenOAuthProvider, opts: { authorizationCode?: string }) => {
        calls.push({ code: opts.authorizationCode })
        if (!opts.authorizationCode) {
          // Old tokens were dropped; the client was registered for another port, so it is gone too.
          expect(provider.tokens()).toBeUndefined()
          expect(provider.clientInformation()).toBeUndefined()
          provider.saveClientInformation({ client_id: 'new' } as never)
          const url = new URL('https://as.example.com/authorize')
          url.searchParams.set('state', provider.state())
          await provider.redirectToAuthorization(url)
          return 'REDIRECT' as const
        }
        provider.saveTokens({ access_token: 'fresh', token_type: 'Bearer' } as never)
        return 'AUTHORIZED' as const
      }
    )
    const open = vi.fn(async (url: URL) => {
      const state = url.searchParams.get('state')!
      setTimeout(() => {
        void get(
          `${store.state.port ? redirectUrlFor(store.state.port) : ''}?code=abc&state=${state}`
        )
      }, 10)
    })
    await signIn('https://mcp.example.com/mcp', store, {
      open,
      authFn: authFn as never,
      timeoutMs: 5000
    })
    busy.close()
    expect(store.state.port).not.toBe(busy.port)
    expect(open).toHaveBeenCalledOnce()
    expect(calls).toEqual([{ code: undefined }, { code: 'abc' }])
    expect(store.state).toMatchObject({
      client: { client_id: 'new' },
      tokens: { access_token: 'fresh' }
    })
  })

  it('times out when the server never answers before the browser step', async () => {
    const close = vi.fn()
    const listen = async (): Promise<Loopback> => ({
      port: 4555,
      wait: () => new Promise(() => {}),
      close
    })
    let fetchSignal: AbortSignal | undefined
    const authFn = vi.fn(async (_p: unknown, opts: { fetchFn: FetchFn }) => {
      // The SDK's requests carry the sign-in's signal.
      await opts.fetchFn('https://mcp.example.com/.well-known/x').catch(() => {})
      return new Promise(() => {})
    })
    const fetchFn = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined
      throw new Error('offline')
    })
    await expect(
      signIn('https://mcp.example.com/mcp', memStore(), {
        open: vi.fn(),
        authFn: authFn as never,
        listen: listen as never,
        fetchFn: fetchFn as never,
        timeoutMs: 50
      })
    ).rejects.toThrow(/timed out/)
    expect(close).toHaveBeenCalledOnce()
    expect(fetchSignal?.aborted).toBe(true)
  })

  it('times out when the browser never comes back', async () => {
    const store = memStore()
    const authFn = vi.fn(async () => 'REDIRECT' as const)
    await expect(
      signIn('https://mcp.example.com/mcp', store, {
        open: vi.fn(),
        authFn: authFn as never,
        timeoutMs: 50
      })
    ).rejects.toThrow(/timed out/)
  })
})
