import { z } from 'zod'

// Payload validators for renderer → main channels. Anything that fails parsing is rejected
// with E_INVALID before it reaches a handler.

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export const promptSchema = z.string().trim().min(1).max(4000)
export const queryOptsSchema = z.object({ lowDetail: z.boolean().optional() }).strict().optional()
export const textSchema = z.string().max(20_000)
export const nameSchema = z.string().max(80)
export const guideIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
/** Lesson ids (07): kebab-case, app id first. */
export const lessonIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
export const lessonCommandSchema = z.enum([
  'next',
  'back',
  'repeat',
  'skip',
  'stop',
  'pause',
  'resume',
  'help',
  'do-it',
  'why',
  'done',
  'slower',
  'faster',
  'yes',
  'no',
  'perform'
])
/** Onboarding practice board button labels. */
export const practiceLabelSchema = z.enum(['Send', 'Save', 'Delete', 'Cancel'])
export const confidenceSchema = z.enum(['high', 'medium', 'low']).optional()
export const dwellPickSchema = z.enum([
  'left',
  'right',
  'double',
  'drag',
  'scroll',
  'pause',
  'keyboard'
])
/** Scan keyboard key id: c:<char>, s:<n> or a named key. */
export const keyboardKeySchema = z.string().regex(/^(c:.|s:\d|[a-z]{2,10})$/u)
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

// CONTRACTS C4 Target (renderer → main for click_target).
const target = z.union([
  z.object({ kind: z.literal('element'), id: z.string().max(64) }),
  z.object({ kind: z.literal('mark'), n: z.number().int().min(0).max(1000) }),
  z.object({
    kind: z.literal('text'),
    text: z.string().max(500),
    nth: z.number().int().min(-100).max(100).optional()
  }),
  z.object({ kind: z.literal('point'), x: coord, y: coord, frame: z.string().max(8) }),
  z.object({
    kind: z.literal('rect'),
    x: coord,
    y: coord,
    w: coord,
    h: coord,
    frame: z.string().max(8)
  })
])

export const actionSchema = z
  .object({
    type: z.enum([
      'move',
      'click',
      'click_target',
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
    target: target.optional(),
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
