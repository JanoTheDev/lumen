vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/actions/policy', () => ({ gate: vi.fn() }))

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorInput, ConnectorServer } from '@shared/connectors'
import { Connectors } from '../../src/main/connectors'
import type { Connect, McpConnection } from '../../src/main/connectors/mcp'
import {
  applyInput,
  commandLine,
  ConnectorSecrets,
  readServers,
  urlProblem,
  type Cipher
} from '../../src/main/connectors/store'
import { tempDir } from '../helpers/fixtures'

const cipher: Cipher = {
  available: () => true,
  encrypt: (t) => Buffer.from(Buffer.from(t).toString('base64')),
  decrypt: (d) => Buffer.from(d.toString(), 'base64').toString()
}

let cleanup = (): void => {}
afterEach(() => cleanup())

function setup(connect: Connect = vi.fn()): {
  c: Connectors
  file: string
  secretsFile: string
} {
  const t = tempDir()
  cleanup = t.cleanup
  const file = join(t.dir, 'connectors.json')
  const secretsFile = join(t.dir, 'connectors.dat')
  return { c: new Connectors({ file, secretsFile, cipher, connect }), file, secretsFile }
}

const web = (bearer?: string): ConnectorInput => ({
  id: 'web',
  name: 'Web',
  transport: 'http',
  url: 'https://mcp.example.com',
  ...(bearer !== undefined ? { bearer } : {})
})

describe('connector settings', () => {
  it('stdio needs explicit trust for the exact command line', () => {
    const input = {
      id: 'fs',
      name: 'Files',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'pkg']
    }
    expect(applyInput(input, undefined)).toMatchObject({ ok: false })
    const r = applyInput({ ...input, trustCommand: true }, undefined)
    expect(r).toMatchObject({ ok: true, server: { trusted: true } })
    const prev = (r as { server: ConnectorServer }).server
    expect(applyInput({ ...input, name: 'Renamed' }, prev).ok).toBe(true)
    expect(applyInput({ ...input, args: ['-y', 'other'] }, prev)).toMatchObject({ ok: false })
  })

  it('http needs https (http only on localhost) and no credentials in the URL', () => {
    expect(urlProblem('https://mcp.example.com/mcp')).toBeNull()
    expect(urlProblem('http://localhost:3000/mcp')).toBeNull()
    expect(urlProblem('http://example.com/mcp')).toMatch(/https/)
    expect(urlProblem('https://u:p@example.com')).toMatch(/credentials/)
    expect(urlProblem('file:///c:/x')).toMatch(/https/)
  })

  it('quotes the command line it shows', () => {
    expect(commandLine('C:\\Program Files\\x.exe', ['--dir', 'C:\\My Docs'])).toBe(
      '"C:\\Program Files\\x.exe" --dir "C:\\My Docs"'
    )
  })

  it('skips invalid entries in connectors.json', () => {
    const { file } = setup()
    const base = { transport: 'http', url: 'https://x.y', enabled: true, toolPolicy: {} }
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          { ...base, id: 'ok', name: 'OK' },
          { ...base, id: 'Bad Id', name: 'x' },
          { ...base, id: 'ok', name: 'dup' }
        ]
      })
    )
    expect(readServers(file).map((s) => s.id)).toEqual(['ok'])
    writeFileSync(file, '{oops')
    expect(readServers(file)).toEqual([])
  })

  it('keeps secrets out of connectors.json and encrypted at rest', () => {
    const { c, file, secretsFile } = setup()
    const added = c.add({
      id: 'cal',
      name: 'Calendar',
      transport: 'stdio',
      command: 'cal-mcp',
      trustCommand: true,
      env: { CAL_TOKEN: 'super-secret-value' }
    })
    expect(added).toEqual({ ok: true })
    expect(c.add(web('tok-123456'))).toEqual({ ok: true })
    const json = readFileSync(file, 'utf8')
    expect(json).not.toContain('super-secret-value')
    expect(json).not.toContain('tok-123456')
    expect(json).toContain('CAL_TOKEN')
    expect(readFileSync(secretsFile, 'utf8')).not.toContain('super-secret-value')
    expect(new ConnectorSecrets(secretsFile, cipher).get('cal').env).toEqual({
      CAL_TOKEN: 'super-secret-value'
    })
    const view = c.list()
    expect(view.find((v) => v.id === 'web')).toMatchObject({ hasBearer: true, state: 'idle' })
    expect(view.find((v) => v.id === 'cal')!.commandLine).toBe('cal-mcp')
    expect(JSON.stringify(view)).not.toContain('tok-123456')
    // Omitted keeps the secret, '' removes it.
    c.update(web())
    expect(c.list().find((v) => v.id === 'web')!.hasBearer).toBe(true)
    c.update(web(''))
    expect(c.list().find((v) => v.id === 'web')!.hasBearer).toBe(false)
  })

  it('remove drops the server and its secrets', async () => {
    const { c, secretsFile } = setup()
    c.add(web('tok-123456'))
    expect(c.add(web())).toMatchObject({ ok: false })
    expect(await c.remove('web')).toEqual({ ok: true })
    expect(c.list()).toEqual([])
    expect(new ConnectorSecrets(secretsFile, cipher).get('web')).toEqual({})
  })

  it('test reports the tool count or the error; the tool set skips a server that is down', async () => {
    const conn: McpConnection = {
      listTools: async () => [
        { name: 'a', description: '', inputSchema: {}, readOnly: true, destructive: false }
      ],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
      onClose: () => {}
    }
    const connect = vi.fn<Connect>(async (s) => {
      if (s.id === 'down') throw new Error('connect ECONNREFUSED')
      return conn
    })
    const { c } = setup(connect)
    c.add({ id: 'up', name: 'Up', transport: 'http', url: 'https://up.example.com' })
    c.add({ id: 'down', name: 'Down', transport: 'http', url: 'https://down.example.com' })
    expect(await c.test('up')).toEqual({ ok: true, toolCount: 1 })
    expect(await c.test('down')).toEqual({ ok: false, error: 'connect ECONNREFUSED' })
    expect(await c.tools('up')).toEqual([
      { name: 'a', description: '', readOnly: true, destructive: false, policy: 'default' }
    ])
    const set = await c.toolSet({ taskId: 't', prompt: 'p' })
    expect(set.defs.map((d) => d.name)).toEqual(['mcp__up__a'])
    expect(Object.keys(set.handlers)).toEqual(['mcp__up__a'])
  })

  it('no enabled server: no tools and no connection attempt', async () => {
    const connect = vi.fn<Connect>()
    const { c } = setup(connect)
    expect(await c.toolSet({ taskId: 't', prompt: 'p' })).toEqual({ defs: [], handlers: {} })
    expect(connect).not.toHaveBeenCalled()
  })
})
