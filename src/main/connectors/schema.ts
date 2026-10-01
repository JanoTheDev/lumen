// MCP tool input schemas → zod, for the strict tool definitions both providers take. Only the
// strict subset converts: objects with listed properties, strings (enum/const), numbers,
// integers, booleans and arrays. Bounds, formats, patterns and defaults are dropped (the
// server still validates its own input). Anything else (unions, nullable types, free-form
// maps, $ref) returns null, and the caller falls back to a JSON-text "arguments" field.
import { z, type ZodType } from 'zod'

type Json = Record<string, unknown>

const MAX_DEPTH = 6
const MAX_DESC = 300

export interface Converted {
  schema: ZodType
  /** Optional properties at every level (Anthropic caps them across strict tools). */
  optional: number
}

function describe<T extends ZodType>(s: T, node: Json): T {
  const d = typeof node.description === 'string' ? node.description.trim() : ''
  return d ? (s.describe(d.slice(0, MAX_DESC)) as T) : s
}

function convert(node: unknown, depth: number, count: { n: number }): ZodType | null {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > MAX_DEPTH) return null
  const n = node as Json
  if (n.$ref || n.anyOf || n.oneOf || n.allOf || n.not) return null
  if (Array.isArray(n.enum)) {
    const vals = n.enum
    if (!vals.length || !vals.every((v) => typeof v === 'string')) return null
    return describe(z.enum(vals as [string, ...string[]]), n)
  }
  if (typeof n.const === 'string') return describe(z.literal(n.const), n)
  switch (n.type) {
    case 'string':
      return describe(z.string(), n)
    case 'number':
      return describe(z.number(), n)
    case 'integer':
      return describe(z.number().int(), n)
    case 'boolean':
      return describe(z.boolean(), n)
    case 'array': {
      const items = convert(n.items, depth + 1, count)
      return items ? describe(z.array(items), n) : null
    }
    case 'object':
      return objectOf(n, depth, count)
    default:
      return null
  }
}

function objectOf(n: Json, depth: number, count: { n: number }): ZodType | null {
  const props = (n.properties ?? {}) as Json
  if (typeof props !== 'object' || Array.isArray(props)) return null
  // A map with only free keys cannot be strict (additionalProperties must be false); extra
  // keys next to listed properties are simply not offered.
  const extra = n.additionalProperties
  if (!Object.keys(props).length && extra !== undefined && extra !== false) return null
  const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : [])
  const shape: Record<string, ZodType> = {}
  for (const [key, p] of Object.entries(props)) {
    const s = convert(p, depth + 1, count)
    if (!s) return null
    if (required.has(key)) shape[key] = s
    else {
      count.n++
      shape[key] = s.optional()
    }
  }
  return describe(z.object(shape), n)
}

/** The zod schema of an MCP tool input, or null when it is outside the strict subset. */
export function fromToolSchema(inputSchema: unknown): Converted | null {
  const count = { n: 0 }
  const root = (inputSchema ?? { type: 'object' }) as Json
  if (root.type !== undefined && root.type !== 'object') return null
  const schema = objectOf(root, 0, count)
  return schema ? { schema, optional: count.n } : null
}

const KEEP = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'description',
  'anyOf',
  'oneOf',
  'additionalProperties'
])

/** A compact copy of a schema for a tool description (bounds and metadata dropped). */
export function compactSchema(node: unknown, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((n) => compactSchema(n, depth + 1))
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return node
  const out: Json = {}
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === 'properties' && v && typeof v === 'object')
      out[k] = Object.fromEntries(
        Object.entries(v as Json).map(([name, p]) => [name, compactSchema(p, depth + 1)])
      )
    else if (k === 'description' && typeof v === 'string') out[k] = v.slice(0, MAX_DESC)
    else if (KEEP.has(k)) out[k] = compactSchema(v, depth + 1)
  }
  return out
}
