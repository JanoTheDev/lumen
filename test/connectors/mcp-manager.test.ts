// McpManager with a fake connection: trust and URL re-checked at connect time (review L3), a
// connection that cannot list its tools is closed (review L2).
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorServer } from '@shared/connectors'
import { McpManager, type Connect, type McpConnection } from '../../src/main/connectors/mcp'

const stdio = (over: Partial<ConnectorServer> = {}): ConnectorServer => ({
  id: 'notes',
  name: 'Notes',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  enabled: true,
  trusted: true,
  toolPolicy: {},
  ...over
})

function fakeConn(listTools: () => Promise<never> | Promise<[]>): McpConnection & {
  close: ReturnType<typeof vi.fn>
} {
  return {
    listTools,
    callTool: vi.fn(),
    close: vi.fn(async () => {}),
    onClose: () => {}
  }
}

describe('McpManager connect checks', () => {
  it('never starts a stdio command without the trust mark (hand-edited connectors.json)', async () => {
    const connect = vi.fn<Connect>()
    const server = stdio({ trusted: undefined })
    const m = new McpManager({ servers: () => [server], secrets: () => ({}), connect })
    await expect(m.ensure(server, true)).rejects.toThrow(/trusted/)
    expect(connect).not.toHaveBeenCalled()
    expect(m.state(server)).toMatchObject({ state: 'error' })
  })

  it('never connects to a plain-http remote URL', async () => {
    const connect = vi.fn<Connect>()
    const server: ConnectorServer = {
      id: 'web',
      name: 'Web',
      transport: 'http',
      url: 'http://evil.example/mcp',
      enabled: true,
      toolPolicy: {}
    }
    const m = new McpManager({ servers: () => [server], secrets: () => ({}), connect })
    await expect(m.ensure(server, true)).rejects.toThrow(/https/)
    expect(connect).not.toHaveBeenCalled()
  })

  it('closes a connection whose tool list fails', async () => {
    const conn = fakeConn(() => Promise.reject(new Error('boom')))
    const server = stdio()
    const m = new McpManager({
      servers: () => [server],
      secrets: () => ({}),
      connect: async () => conn
    })
    await expect(m.ensure(server, true)).rejects.toThrow(/boom/)
    expect(conn.close).toHaveBeenCalledTimes(1)
  })
})
