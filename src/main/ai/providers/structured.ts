// JSON Schema for structured output, generated from the zod schema.
// Reply schemas use `.optional()` for absent fields: Anthropic caps union-typed params at 16
// but allows 24 optional ones, so its variant keeps them optional. OpenAI strict mode needs
// every field required, so its variant turns each optional field into `anyOf [field, null]`;
// parseJsonAs drops the nulls again before validation. Both are inlined (no $refs) and keep
// `const`/`enum` (the SDK zod helper moves those into descriptions, so they are not enforced).
import { toJSONSchema, type ZodType } from 'zod'

type Json = Record<string, unknown>

// Bounds strict mode rejects or ignores (zod's .int() adds safe-integer bounds); the zod
// schema still enforces them when the reply is parsed.
const DROPPED = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems'
]

function strict(node: unknown, nullableOptionals: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => strict(n, nullableOptionals))
  if (!node || typeof node !== 'object') return node
  const out: Json = {}
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === 'properties' && v && typeof v === 'object')
      // Field names, not keywords: keep every key.
      out[k] = Object.fromEntries(
        Object.entries(v as Json).map(([name, p]) => [name, strict(p, nullableOptionals)])
      )
    else if (!DROPPED.includes(k)) out[k] = strict(v, nullableOptionals)
  }
  if (Array.isArray(out.oneOf)) {
    out.anyOf = out.oneOf
    delete out.oneOf
  }
  if (out.type === 'object') {
    const props = (out.properties ?? {}) as Record<string, Json>
    out.properties = props
    out.additionalProperties = false
    if (nullableOptionals) {
      const required = new Set((out.required as string[] | undefined) ?? [])
      for (const key of Object.keys(props)) {
        if (!required.has(key)) props[key] = { anyOf: [props[key], { type: 'null' }] }
      }
      out.required = Object.keys(props)
    }
  }
  return out
}

function inline(schema: ZodType): Json {
  const json = toJSONSchema(schema, { io: 'output', target: 'draft-7', reused: 'inline' }) as Json
  delete json.$schema
  return json
}

function deepFreeze<T>(node: T): T {
  if (node && typeof node === 'object' && !Object.isFrozen(node)) {
    Object.freeze(node)
    for (const v of Object.values(node)) deepFreeze(v)
  }
  return node
}

const anthropicCache = new WeakMap<ZodType, Json>()
const openaiCache = new WeakMap<ZodType, Json>()

function cached(cache: WeakMap<ZodType, Json>, schema: ZodType, nullable: boolean): Json {
  let json = cache.get(schema)
  if (!json) {
    json = deepFreeze(strict(inline(schema), nullable) as Json)
    cache.set(schema, json)
  }
  return json
}

/**
 * Anthropic `output_config.format` schema: optional fields stay optional. One frozen object
 * per zod schema, so request bodies built from it stay identical.
 */
export function anthropicJsonSchema(schema: ZodType): Json {
  return cached(anthropicCache, schema, false)
}

/** OpenAI strict `json_schema` body: every field required, optional ones nullable. Frozen. */
export function openaiStrictSchema(schema: ZodType): Json {
  return cached(openaiCache, schema, true)
}
