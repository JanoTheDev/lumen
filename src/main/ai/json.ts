// Tolerant JSON helpers for model output: providers without structured output (local models)
// and streamed partial replies.
import type { ZodType } from 'zod'

/** The first balanced {...} object in s, skipping leading prose and fences; null if none. */
export function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/** Copy of v with every null object property removed (strict schemas send null for "absent"). */
export function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripNulls) as T
  if (!v || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v)) if (val !== null) out[k] = stripNulls(val)
  return out as T
}

/** Parses a model reply against a schema, tolerating prose around the JSON. */
export function parseJsonAs<T>(text: string, schema: ZodType<T>): T | null {
  const raw = extractJsonObject(text)
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const res = schema.safeParse(stripNulls(value))
  if (res.success) return res.data
  const issues = res.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ')
  console.warn(`[schema] reply did not match: ${issues}`)
  return null
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
}

/**
 * Reads the string value of the first `"key": "..."` in a JSON prefix that may be cut off
 * anywhere. Returns the decoded text so far and whether the closing quote was seen, or null
 * when the value has not started yet. An escape cut in half is left for the next call.
 */
export function readPartialString(
  buf: string,
  key: string
): { text: string; done: boolean } | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(buf)
  if (!m) return null
  let text = ''
  for (let i = m.index + m[0].length; i < buf.length; i++) {
    const c = buf[i]
    if (c === '"') return { text, done: true }
    if (c !== '\\') {
      text += c
      continue
    }
    const next = buf[i + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = buf.slice(i + 2, i + 6)
      if (hex.length < 4) break
      text += String.fromCharCode(parseInt(hex, 16))
      i += 5
    } else {
      text += ESCAPES[next] ?? next
      i++
    }
  }
  return { text, done: false }
}
