// Integration: the real SDK client against the stdio fixture server.
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ConnectorServer } from '@shared/connectors'
import { McpManager, sdkConnect, MAX_RESULT_CHARS } from '../../src/main/connectors/mcp'

const fixture: ConnectorServer = {
  id: 'fixture',
  name: 'Fixture',
  transport: 'stdio',
  command: process.execPath,
  args: ['--experimental-strip-types', '--no-warnings', join(__dirname, 'fixture-server.ts')],
  envNames: ['FIXTURE_SECRET'],
  enabled: true,
  trusted: true,
  toolPolicy: {}
}

const manager = new McpManager({
  servers: () => [fixture],
  secrets: () => ({ env: { FIXTURE_SECRET: 'from-the-vault' } }),
  connect: sdkConnect
})

afterAll(() => manager.closeAll())

describe('MCP over stdio', () => {
  it('lists tools with their annotations', async () => {
    const tools = await manager.tools(fixture)
    expect(tools.map((t) => t.name).sort()).toEqual(['big', 'delete_note', 'echo', 'env', 'fail'])
    const echo = tools.find((t) => t.name === 'echo')!
    expect(echo.readOnly).toBe(true)
    expect(tools.find((t) => t.name === 'delete_note')!.destructive).toBe(true)
    expect(echo.inputSchema).toMatchObject({ type: 'object', required: ['text'] })
  }, 20_000)

  it('calls tools and passes env secrets to the command', async () => {
    const r = await manager.call(fixture, 'echo', { text: 'hi', times: 2 })
    expect(r).toEqual({ content: [{ type: 'text', text: 'hihi' }], isError: false })
    const env = await manager.call(fixture, 'env', {})
    expect(env.content[0]).toEqual({ type: 'text', text: 'from-the-vault' })
  }, 20_000)

  it('reports tool errors and cuts long results', async () => {
    expect((await manager.call(fixture, 'fail', {})).isError).toBe(true)
    const big = await manager.call(fixture, 'big', {})
    const first = big.content[0] as { text: string }
    expect(first.text).toHaveLength(MAX_RESULT_CHARS)
    expect((big.content[1] as { text: string }).text).toMatch(/10000 more characters/)
  }, 20_000)

  it('reconnects after the connection was closed', async () => {
    await manager.disconnect('fixture')
    expect(manager.state(fixture).state).toBe('idle')
    const r = await manager.call(fixture, 'echo', { text: 'again' })
    expect(r.content[0]).toEqual({ type: 'text', text: 'again' })
    expect(manager.state(fixture)).toMatchObject({ state: 'connected', toolCount: 5 })
  }, 20_000)

  it('a command that does not start reports the error', async () => {
    const bad: ConnectorServer = { ...fixture, id: 'bad', command: 'lumen-no-such-command-xyz' }
    const m = new McpManager({ servers: () => [bad], secrets: () => ({}), connect: sdkConnect })
    await expect(m.tools(bad)).rejects.toThrow()
    expect(m.state(bad).state).toBe('error')
    await m.closeAll()
  }, 20_000)
})
