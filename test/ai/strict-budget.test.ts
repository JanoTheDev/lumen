import { describe, expect, it } from 'vitest'

import type { ConnectorServer } from '@shared/connectors'
import { buildToolParams, STRICT_LIMITS, strictCounts } from '../../src/main/ai/providers/anthropic'
import type { ToolDef } from '../../src/main/ai/providers/types'
import { FOREGROUND_TOOLS, toolSet } from '../../src/main/agent-mode/tools'
import { BG_TOOLS, backgroundToolDefs } from '../../src/main/agent-mode/background/tools'
import { skillToolDefs } from '../../src/main/skills/disclosure'
import { MEMORY_SEARCH_TOOL } from '../../src/main/ai/memory/search'
import { CREATE_FILE_TOOL } from '../../src/main/docs-out/tool'
import { GRANTED_FILE_TOOLS } from '../../src/main/files/granted'
import type { McpTool } from '../../src/main/connectors/mcp'
import { mcpToolDefs } from '../../src/main/connectors/tools'

const server = (id: string): ConnectorServer => ({
  id,
  name: id,
  transport: 'stdio',
  command: 'node',
  enabled: true,
  trusted: true,
  toolPolicy: {}
})

const required = (name: string): McpTool => ({
  name,
  description: name,
  inputSchema: {
    type: 'object',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, n: { type: 'integer' } },
    required: ['owner', 'repo', 'n']
  },
  readOnly: true,
  destructive: false
})

const optional = (name: string): McpTool => ({
  ...required(name),
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' }, limit: { type: 'integer' }, page: { type: 'integer' } }
  }
})

/** Two connectors with many simple tools, most of them fitting the strict subset. */
function connectorDefs(): ToolDef[] {
  return mcpToolDefs([
    {
      server: server('github'),
      tools: Array.from({ length: 12 }, (_, i) => required(`get_${i}`))
    },
    {
      server: server('search'),
      tools: Array.from({ length: 6 }, (_, i) => optional(`find_${i}`))
    }
  ]).map((e) => e.def)
}

function check(defs: ToolDef[]): { strict: string[]; loose: string[] } {
  const params = buildToolParams({
    model: 'claude-sonnet-5-5',
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: defs,
    maxTokens: 1000
  })
  const tools = params.tools as { name: string; strict?: boolean; input_schema: unknown }[]
  const strict = tools.filter((t) => t.strict)
  const totals = strict
    .map((t) => strictCounts(t.input_schema))
    .reduce((a, b) => ({ optional: a.optional + b.optional, unions: a.unions + b.unions }), {
      optional: 0,
      unions: 0
    })
  expect(strict.length).toBeLessThanOrEqual(STRICT_LIMITS.tools)
  expect(totals.optional).toBeLessThanOrEqual(STRICT_LIMITS.optional)
  expect(totals.unions).toBeLessThanOrEqual(STRICT_LIMITS.unions)
  expect(tools).toHaveLength(defs.length)
  return {
    strict: strict.map((t) => t.name),
    loose: tools.filter((t) => !t.strict).map((t) => t.name)
  }
}

describe('Anthropic request-wide strict budget', () => {
  it('fullest foreground set + many connector tools stays in the limits, built-ins strict', () => {
    const builtIn = [
      ...toolSet([...FOREGROUND_TOOLS, 'read_file']),
      MEMORY_SEARCH_TOOL,
      ...skillToolDefs({ truncated: true }),
      BG_TOOLS.spawn_task
    ]
    const mcp = connectorDefs()
    const r = check([...builtIn, ...mcp])
    for (const t of builtIn) expect(r.strict).toContain(t.name)
    for (const t of mcp) expect(r.loose).toContain(t.name)
  })

  it('fullest background set + connector tools: some connector tools stay strict, rest loose', () => {
    const builtIn = [
      ...toolSet(['ask_user', 'finish']),
      ...backgroundToolDefs({ child: false }),
      ...skillToolDefs({ truncated: true }),
      CREATE_FILE_TOOL,
      ...Object.values(GRANTED_FILE_TOOLS)
    ]
    const mcp = connectorDefs()
    const r = check([...builtIn, ...mcp])
    for (const t of builtIn) expect(r.strict).toContain(t.name)
    expect(r.strict.some((n) => n.startsWith('mcp__'))).toBe(true)
    expect(r.loose.some((n) => n.startsWith('mcp__'))).toBe(true)
  })

  it('connector tools listed before built-ins still yield to them', () => {
    const builtIn = toolSet(FOREGROUND_TOOLS)
    const r = check([...connectorDefs(), ...builtIn])
    for (const t of builtIn) expect(r.strict).toContain(t.name)
  })
})
