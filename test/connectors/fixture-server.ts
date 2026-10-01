// A tiny stdio MCP server for the connector tests (run with node --experimental-strip-types).
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

serveStdio(() => {
  const server = new McpServer(
    { name: 'fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.registerTool(
    'echo',
    {
      description: 'Echoes the text back.',
      inputSchema: z.object({ text: z.string(), times: z.number().int().optional() }),
      annotations: { readOnlyHint: true }
    },
    async ({ text, times }) => ({
      content: [{ type: 'text', text: text.repeat(times ?? 1) }]
    })
  )
  server.registerTool(
    'delete_note',
    {
      description: 'Deletes a note.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true }
    },
    async ({ id }) => ({ content: [{ type: 'text', text: `deleted ${id}` }] })
  )
  server.registerTool(
    'big',
    { description: 'Returns a long text.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: 'x'.repeat(30_000) }] })
  )
  server.registerTool(
    'fail',
    { description: 'Always fails.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true })
  )
  server.registerTool(
    'env',
    { description: 'Reads FIXTURE_SECRET.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: process.env.FIXTURE_SECRET ?? '' }] })
  )
  return server
})
