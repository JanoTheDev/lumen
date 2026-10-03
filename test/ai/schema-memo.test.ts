import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { replySchema } from '../../src/main/ai/schema'
import { strictCounts } from '../../src/main/ai/providers/anthropic'
import { anthropicJsonSchema, openaiStrictSchema } from '../../src/main/ai/providers/structured'

describe('json schema memo', () => {
  it('returns the same frozen object for the same zod schema', () => {
    for (const fn of [anthropicJsonSchema, openaiStrictSchema]) {
      const a = fn(replySchema)
      expect(fn(replySchema)).toBe(a)
      expect(Object.isFrozen(a)).toBe(true)
      expect(Object.isFrozen(a.properties ?? a.anyOf)).toBe(true)
      expect(() => {
        ;(a as Record<string, unknown>).extra = 1
      }).toThrow()
    }
  })

  it('keeps the variants apart and gives equal schemas equal output', () => {
    const make = (): z.ZodType => z.object({ a: z.string(), b: z.number().optional() })
    const x = make()
    const y = make()
    expect(anthropicJsonSchema(x)).not.toBe(anthropicJsonSchema(y))
    expect(anthropicJsonSchema(x)).toEqual(anthropicJsonSchema(y))
    expect(openaiStrictSchema(x)).not.toEqual(anthropicJsonSchema(x))
    expect(openaiStrictSchema(x).required).toEqual(['a', 'b'])
    expect(anthropicJsonSchema(x).required).toEqual(['a'])
  })

  it('counts a frozen schema once and a plain object every time', () => {
    const schema = anthropicJsonSchema(z.object({ a: z.string().optional() }))
    expect(strictCounts(schema)).toBe(strictCounts(schema))
    expect(strictCounts(schema)).toEqual({ optional: 1, unions: 0 })
    const plain: Record<string, unknown> = { type: 'object', properties: { a: {} } }
    expect(strictCounts(plain)).toEqual({ optional: 1, unions: 0 })
    plain.properties = { a: {}, b: {} }
    expect(strictCounts(plain)).toEqual({ optional: 2, unions: 0 })
  })
})
