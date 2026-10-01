vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/actions/policy', () => ({ gate: vi.fn() }))

// The integrations catalog: every entry is something connectors:add accepts, with an official
// source and a check date; local entries still need the trust tick.
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_CATALOG, catalogArgs, type CatalogEntry } from '@shared/connector-catalog'
import { Connectors } from '../../src/main/connectors'
import type { Loopback, LumenOAuthProvider } from '../../src/main/connectors/oauth'
import { SERVER_ID_RE, applyInput, inputSchema, urlProblem } from '../../src/main/connectors/store'
import { tempDir } from '../helpers/fixtures'

const inputFor = (e: CatalogEntry, folders: string[] = ['C:\\Notes']): Record<string, unknown> =>
  e.kind === 'remote'
    ? {
        id: e.id,
        name: e.name,
        transport: 'http',
        url: e.url,
        ...(e.oauth ? { auth: 'oauth' } : {})
      }
    : {
        id: e.id,
        name: e.name,
        transport: 'stdio',
        command: e.command,
        args: catalogArgs(e, folders),
        trustCommand: true
      }

describe('connector catalog', () => {
  it('entries are unique, well formed and sourced', () => {
    const ids = CONNECTOR_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of CONNECTOR_CATALOG) {
      expect(e.id, e.id).toMatch(SERVER_ID_RE)
      expect(e.name.length, e.id).toBeLessThanOrEqual(60)
      expect(e.description.length, e.id).toBeGreaterThan(10)
      expect(e.source, e.id).toMatch(/^https:\/\//)
      expect(e.checked, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      if (e.kind === 'remote') {
        expect(urlProblem(e.url), e.id).toBeNull()
        expect(e.command, e.id).toBeUndefined()
      } else {
        expect(e.command, e.id).toMatch(/^(npx|uvx)$/)
        expect(e.url, e.id).toBeUndefined()
        expect(e.oauth, e.id).toBeUndefined()
        // npx must never stop to ask "Ok to proceed?" on the MCP stdin.
        if (e.command === 'npx') expect(e.args?.[0], e.id).toBe('-y')
      }
    }
  })

  it('every entry passes the connectors:add schema and the store rules', () => {
    for (const e of CONNECTOR_CATALOG) {
      const parsed = inputSchema.safeParse(inputFor(e))
      expect(parsed.success, e.id).toBe(true)
      const r = applyInput(parsed.data!, undefined)
      expect(r.ok, e.id).toBe(true)
      if (r.ok && e.oauth) expect(r.server.auth).toBe('oauth')
    }
  })

  it('local entries still need the trust tick', () => {
    const e = CONNECTOR_CATALOG.find((x) => x.kind === 'local')!
    const input = { ...inputFor(e), trustCommand: false }
    expect(applyInput(inputSchema.parse(input), undefined)).toMatchObject({ ok: false })
  })

  it('fills folders in as arguments', () => {
    const files = CONNECTOR_CATALOG.find((e) => e.id === 'files')!
    expect(catalogArgs(files, ['C:\\A', ' ', 'D:\\B'])).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      'C:\\A',
      'D:\\B'
    ])
    const git = CONNECTOR_CATALOG.find((e) => e.id === 'git')!
    expect(catalogArgs(git, ['C:\\repo', 'C:\\other'])).toEqual([
      'mcp-server-git',
      '--repository',
      'C:\\repo'
    ])
  })
})

describe('OAuth connectors', () => {
  let cleanup = (): void => {}
  afterEach(() => cleanup())

  const cipher = {
    available: () => true,
    encrypt: (t: string) => Buffer.from(Buffer.from(t).toString('base64')),
    decrypt: (d: Buffer) => Buffer.from(d.toString(), 'base64').toString()
  }

  function setup(): Connectors {
    const t = tempDir()
    cleanup = t.cleanup
    return new Connectors({
      file: join(t.dir, 'connectors.json'),
      secretsFile: join(t.dir, 'connectors.dat'),
      cipher,
      connect: vi.fn()
    })
  }

  it('needs a sign-in before connecting; tokens show as signedIn and go on sign-out', async () => {
    const c = setup()
    expect(
      c.add({
        id: 'notion',
        name: 'Notion',
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth'
      })
    ).toEqual({ ok: true })
    expect(c.list()[0]).toMatchObject({ auth: 'oauth', signedIn: false })
    expect(await c.test('notion')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Sign in/)
    })
    c.oauthStore('notion').save({ tokens: { access_token: 'x', token_type: 'Bearer' }, port: 5000 })
    expect(c.list()[0].signedIn).toBe(true)
    // Stored encrypted with the other secrets, not in connectors.json.
    expect(c.secrets.get('notion').oauth?.port).toBe(5000)
    expect(await c.signOut('notion')).toEqual({ ok: true })
    expect(c.list()[0].signedIn).toBe(false)
  })

  it('a sign-in still open when the connector is removed or re-added leaves nothing behind', async () => {
    const c = setup()
    const input = {
      id: 'late',
      name: 'Late',
      transport: 'http' as const,
      url: 'https://a.example.com/mcp',
      auth: 'oauth' as const
    }
    c.add(input)
    let release = (): void => {}
    const gateOpen = new Promise<void>((r) => (release = r))
    const authFn = vi.fn(async (provider: LumenOAuthProvider) => {
      await gateOpen
      provider.saveClientInformation({ client_id: 'c' } as never)
      provider.saveTokens({ access_token: 'x', token_type: 'Bearer' } as never)
      return 'AUTHORIZED' as const
    })
    const listen = async (): Promise<Loopback> => ({
      port: 4777,
      wait: () => new Promise(() => {}),
      close: () => {}
    })
    const pending = c.signIn('late', { open: vi.fn(), authFn: authFn as never, listen })
    await vi.waitFor(() => expect(authFn).toHaveBeenCalled())
    await c.remove('late')
    release()
    expect(await pending).toMatchObject({ ok: false })
    expect(c.secrets.get('late').oauth).toBeUndefined()
    // The same id added again starts signed out.
    c.add(input)
    expect(c.list()[0].signedIn).toBe(false)
  })

  it('a new address drops the old sign-in', () => {
    const c = setup()
    c.add({
      id: 'w',
      name: 'W',
      transport: 'http',
      url: 'https://a.example.com/mcp',
      auth: 'oauth'
    })
    c.oauthStore('w').save({ tokens: { access_token: 'x' } })
    c.update({
      id: 'w',
      name: 'W',
      transport: 'http',
      url: 'https://a.example.com/mcp',
      auth: 'oauth'
    })
    expect(c.list()[0].signedIn).toBe(true)
    c.update({
      id: 'w',
      name: 'W',
      transport: 'http',
      url: 'https://b.example.com/mcp',
      auth: 'oauth'
    })
    expect(c.list()[0].signedIn).toBe(false)
  })
})
