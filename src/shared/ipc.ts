import { z } from 'zod'

// Payload validators for renderer → main channels. Anything that fails parsing is rejected
// with E_INVALID before it reaches a handler.

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export const promptSchema = z.string().trim().min(1).max(4000)
export const queryOptsSchema = z.object({ lowDetail: z.boolean().optional() }).strict().optional()
export const textSchema = z.string().max(20_000)
export const nameSchema = z.string().max(80)
export const guideIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export const confidenceSchema = z.enum(['high', 'medium', 'low']).optional()
export const overlayHeightSchema = z
  .number()
  .finite()
  .transform((h) => Math.max(60, Math.min(800, Math.round(h))))
export const audioSchema = z
  .instanceof(ArrayBuffer)
  .refine((b) => b.byteLength <= MAX_AUDIO_BYTES, 'audio too large')

const coord = z.number().finite()
// Rect {x,y,w,h}; legacy [x1,y1,x2,y2] arrays are still accepted and normalized in main.
const bbox = z.union([
  z.object({ x: coord, y: coord, w: coord, h: coord }),
  z.tuple([coord, coord, coord, coord])
])

export const actionSchema = z
  .object({
    type: z.enum([
      'move',
      'click',
      'click_bbox',
      'click_element',
      'click_nth_element',
      'type',
      'hotkey',
      'open_url',
      'navigate_url',
      'focus_browser',
      'scroll'
    ]),
    x: coord.optional(),
    y: coord.optional(),
    bbox: bbox.optional(),
    button: z.enum(['left', 'right']).optional(),
    text: z.string().max(20_000).optional(),
    keys: z.array(z.string().max(20)).max(6).optional(),
    url: z.string().max(4096).optional(),
    n: z.number().int().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().finite().optional()
  })
  .strip()

export const actionsSchema = z.array(actionSchema).max(50)

export class InvalidPayloadError extends Error {
  readonly code = 'E_INVALID'
  constructor(channel: string, detail: string) {
    super(`invalid payload on ${channel}: ${detail}`)
    this.name = 'InvalidPayloadError'
  }
}

/** Parses a payload or throws InvalidPayloadError with a short reason. */
export function parsePayload<T extends z.ZodType>(
  channel: string,
  schema: T,
  value: unknown
): z.infer<T> {
  const r = schema.safeParse(value)
  if (!r.success) {
    const issue = r.error.issues[0]
    throw new InvalidPayloadError(
      channel,
      `${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'invalid'}`
    )
  }
  return r.data
}
