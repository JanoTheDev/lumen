import { z } from 'zod'
import { LESSON_COMMANDS } from './events'
import { FACE_GESTURES } from './config'

// Payload validators for renderer → main channels. Anything that fails parsing is rejected
// with E_INVALID before it reaches a handler.

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export const promptSchema = z.string().trim().min(1).max(4000)
export const queryOptsSchema = z.object({ lowDetail: z.boolean().optional() }).strict().optional()
export const textSchema = z.string().max(20_000)
/** voice:say-done: one spoken message ended in the voice renderer. */
export const sayDoneSchema = z
  .object({
    turnId: z.string().min(1).max(100),
    seq: z.number().int().min(0),
    reason: z.enum(['ended', 'stopped', 'failed'])
  })
  .strict()
export const nameSchema = z.string().max(80)
/** Dictation history entries and notes (04 T44/T45) use random UUIDs. */
export const entryIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const noteTextSchema = z.string().trim().min(1).max(10_000)
/** Voice snippets (04 T38): the whole list, as Settings saves it. */
export const snippetsSaveSchema = z
  .array(
    z
      .object({
        id: z.string().max(64).optional(),
        trigger: z.string().trim().min(2).max(80),
        text: z.string().min(1).max(5000)
      })
      .strict()
  )
  .max(200)
export const guideIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
/** Lesson ids (07): kebab-case, app id first. */
export const lessonIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
export const lessonCommandSchema = z.enum(LESSON_COMMANDS)
/** Record my steps (07 T31). */
export const recordActionSchema = z.enum(['start', 'stop', 'cancel'])
export const lessonDraftEditSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    steps: z
      .array(z.object({ id: z.string().max(80), say: z.string().trim().min(3).max(200) }).strict())
      .min(1)
      .max(40)
  })
  .strict()
/** A GitHub link to a community pack (07 T32). */
export const packUrlSchema = z.string().trim().url().max(500)

/** Skills (11, CONTRACTS C10): kebab-case names, SKILL.md text, install preview tokens. */
export const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
export const skillTextSchema = z
  .string()
  .min(1)
  .max(256 * 1024)
export const skillDescriptionSchema = z.string().max(200)
export const skillTokenSchema = z.string().regex(/^[a-f0-9]{24}$/)
/** "Write it for me": what the skill should do, in the user's words. */
export const skillComposeSchema = z.string().trim().min(4).max(2000)

/** Onboarding practice board button labels. */
export const practiceLabelSchema = z.enum(['Send', 'Save', 'Delete', 'Cancel'])
/** App bridges (07 T23–T26). */
export const bridgeIdSchema = z.enum(['blender', 'obs'])
/** OBS WebSocket settings; an empty password clears it. */
export const obsBridgeSchema = z
  .object({
    password: z.string().max(200).optional(),
    port: z.number().int().min(1024).max(65535).optional()
  })
  .strict()
/** Agent-mode grant scope (08 T03). */
export const grantScopeSchema = z
  .string()
  .max(220)
  .regex(/^(app|mcp|domain|scheme):\S+$/)
/** audit:list query (08 T04). */
export const auditQuerySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    taskId: z.string().max(64).optional()
  })
  .strict()
/** Community labels (11 T13): an app id and a label edit (null label deletes it). */
export const labelAppSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(60)
export const labelEditSchema = z
  .object({
    app: labelAppSchema,
    key: z.string().min(5).max(260),
    label: z.string().max(60).nullable()
  })
  .strict()
/** Helper handoff (11 T24). */
export const handoffExportSchema = z
  .object({
    lessonIds: z.array(lessonIdSchema).min(1).max(50),
    title: z.string().trim().min(1).max(80),
    from: z.string().max(60).optional(),
    note: z.string().max(400).optional(),
    includeLabels: z.boolean()
  })
  .strict()
export const handoffIdSchema = z
  .string()
  .max(70)
  .regex(/^handoff-[a-z0-9]+(-[a-z0-9]+)*$/)
/** Practice challenges (11 T22). */
export const challengeStartSchema = z
  .object({
    app: z.string().max(60).optional(),
    level: z.enum(['beginner', 'intermediate', 'advanced', 'harder', 'easier']).optional()
  })
  .strict()
/** Tutorial → lesson (11 T12). */
const importAppId = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .optional()
export const tutorialImportSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('text'), text: z.string().min(1).max(200_000), appId: importAppId })
    .strict(),
  z
    .object({ kind: z.literal('url'), url: z.string().url().max(2000), appId: importAppId })
    .strict(),
  z.object({ kind: z.literal('file'), appId: importAppId }).strict()
])
/** helpers:journal-read day (11 T23). */
export const journalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
/** Background task ids (08 T29) and a typed answer to a task's question. */
export const bgTaskIdSchema = z.string().regex(/^bg_[a-z0-9]{4,40}$/)
export const bgTaskAnswerSchema = z.tuple([bgTaskIdSchema, z.string().trim().min(1).max(500)])
/** Settings → Usage (05 T44). */
export const usageRangeSchema = z.enum(['today', '7d', '30d', 'month'])
export const usageReportSchema = z.object({ range: usageRangeSchema }).strict()
export const usageCallsSchema = z
  .object({
    range: usageRangeSchema,
    filter: z
      .object({
        group: z.enum([
          'feature',
          'automation',
          'buddy',
          'skill',
          'task',
          'model',
          'bucket',
          'day',
          'claude'
        ]),
        key: z.string().min(1).max(300)
      })
      .strict()
  })
  .strict()
export const usageTasksSchema = z
  .object({ ids: z.array(z.string().min(1).max(100)).max(50) })
  .strict()
export const fileDropSchema = z.object({ path: z.string().min(3).max(1024) }).strict()
export const fileIdSchema = z.string().regex(/^f_[a-z0-9]{4,40}$/)
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

/** Face renderer frames and Settings calibration (11 T25). */
const faceScore = z.number().finite().min(-180).max(180)
export const faceFrameSchema = z
  .object({
    face: z.boolean(),
    mouthOpen: faceScore,
    browRaise: faceScore,
    smile: faceScore,
    roll: faceScore,
    yaw: faceScore
  })
  .strict()
export const faceStatusSchema = z
  .object({ state: z.enum(['running', 'error']), error: z.string().max(300).optional() })
  .strict()
export const faceCalibrateSchema = z.union([
  z.object({ step: z.literal('rest') }).strict(),
  z.object({ step: z.literal('gesture'), gesture: z.enum(FACE_GESTURES) }).strict()
])

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
