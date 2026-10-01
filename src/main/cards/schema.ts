// Strict validator for answer cards (05 T37): length and count caps, https links and images
// only, and every price / rating names a source that is in `sources`. Pure (no Electron).
import { z } from 'zod'
import {
  CARD_ACTIONS,
  CARD_KINDS,
  CARD_LAYOUTS,
  CARD_LIMITS as L,
  type AnswerCards
} from '@shared/cards'
import { isPrivateHost } from '../web/net'

const text = (max: number): z.ZodString => z.string().trim().min(1).max(max)

const https = z
  .string()
  .max(L.url)
  .refine((raw) => {
    try {
      const u = new URL(raw)
      return u.protocol === 'https:' && !u.username && !u.password && !isPrivateHost(u.hostname)
    } catch {
      return false
    }
  }, 'https link required')

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)

const source = z.strictObject({
  id,
  title: text(L.title),
  url: https,
  checkedAt: z.number().int().nonnegative()
})

const image = z.strictObject({
  sourceUrl: https,
  pageUrl: https,
  alt: text(L.alt),
  attribution: text(L.value).optional()
})

const price = z.strictObject({
  amount: z.number().finite().nonnegative().max(1e9),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: text(L.label).optional(),
  note: text(L.note).optional(),
  sourceId: id
})

const rating = z
  .strictObject({
    value: z.number().finite().nonnegative(),
    max: z.number().finite().positive().max(100),
    count: z.number().int().nonnegative().optional(),
    sourceId: id
  })
  .refine((r) => r.value <= r.max, 'rating above its max')

const action = z
  .strictObject({ kind: z.enum(CARD_ACTIONS), label: text(L.label).optional() })
  .refine((a) => a.kind !== 'do' || !!a.label, 'a do action needs a label')

const card = z.strictObject({
  id,
  kind: z.enum(CARD_KINDS),
  title: text(L.title),
  subtitle: text(L.subtitle).optional(),
  image: image.optional(),
  price: price.optional(),
  rating: rating.optional(),
  facts: z.array(z.strictObject({ label: text(L.label), value: text(L.value) })).max(L.facts),
  badges: z.array(text(L.label)).max(L.badges).optional(),
  links: z.array(z.strictObject({ label: text(L.label), url: https })).max(L.links),
  actions: z.array(action).max(L.actions)
})

export const answerCardsSchema = z
  .strictObject({
    layout: z.enum(CARD_LAYOUTS),
    cards: z.array(card).min(1).max(L.cards),
    sources: z.array(source).max(L.sources),
    filters: z
      .array(z.strictObject({ label: text(L.label), match: text(L.label) }))
      .max(L.filters)
      .optional()
  })
  .superRefine((v, ctx) => {
    const known = new Set(v.sources.map((s) => s.id))
    if (known.size !== v.sources.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate source id', path: ['sources'] })
    const ids = new Set<string>()
    v.cards.forEach((c, i) => {
      if (ids.has(c.id))
        ctx.addIssue({ code: 'custom', message: 'duplicate card id', path: ['cards', i, 'id'] })
      ids.add(c.id)
      for (const field of ['price', 'rating'] as const) {
        const ref = c[field]?.sourceId
        if (ref !== undefined && !known.has(ref))
          ctx.addIssue({
            code: 'custom',
            message: `${field} names an unknown source`,
            path: ['cards', i, field, 'sourceId']
          })
      }
    })
  })

export type CardsCheck = { ok: true; cards: AnswerCards } | { ok: false; error: string }

/** Validates cards from a model or a tool; the first problem as a short error. */
export function validateCards(raw: unknown): CardsCheck {
  const r = answerCardsSchema.safeParse(raw)
  if (r.success) return { ok: true, cards: r.data }
  const issue = r.error.issues[0]
  return { ok: false, error: `${issue.path.join('.') || 'cards'}: ${issue.message}` }
}
