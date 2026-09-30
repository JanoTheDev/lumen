import { z } from 'zod'

// Accelerator strings as produced by the settings hotkey capture, e.g. "Ctrl+Shift+Space", "Alt+B", "F9".
const MODIFIER = /(?:Ctrl|Control|Alt|Shift|Win|Super|Meta|CommandOrControl|CmdOrCtrl)\+/.source
const KEY = [
  /[A-Za-z0-9]/.source,
  /F(?:[1-9]|1[0-9]|2[0-4])/.source,
  'Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown',
  /Arrow(?:Up|Down|Left|Right)|Up|Down|Left|Right|Escape|Esc|Plus|Minus/.source,
  /[`\-=[\];',./\\]/.source
].join('|')
export const HOTKEY_RE = new RegExp(`^(?:(?:${MODIFIER})+(?:${KEY})|F(?:[1-9]|1[0-2]))$`, 'i')

// Known model ids plus a conservative free-text pattern for custom ones.
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-:/_]{0,79}$/i

const hex = z.string().regex(/^#[0-9a-f]{6}$/i)
const shortText = (max: number): z.ZodString => z.string().max(max)
const modelId = z.union([z.literal(''), z.string().regex(MODEL_ID_RE)])

export const THEME_NAMES = [
  'dark',
  'light',
  'high-contrast',
  'ocean',
  'forest',
  'sunset',
  'midnight',
  'custom'
] as const

export const configV1Schema = z.object({
  version: z.literal(1),
  theme: z.enum(THEME_NAMES),
  themeCustom: z
    .object({
      accent: hex,
      background: hex,
      foreground: hex,
      opacity: z.number().min(0).max(1),
      blur: z.number().min(0).max(64)
    })
    .optional(),
  models: z.object({
    planning: modelId.optional(),
    execution: modelId.optional(),
    verification: modelId.optional()
  }),
  hotkey: z.string().regex(HOTKEY_RE),
  hudAutoCloseMs: z.number().int().min(0).max(600_000),
  answerAutoCloseMs: z.number().int().min(0).max(600_000),
  wakeWord: z.object({ enabled: z.boolean(), phrase: shortText(60) }),
  statusBubble: z.object({ enabled: z.boolean() }),
  voiceVocab: shortText(2000),
  historyEnabled: z.boolean(),
  explainBeforeDo: z.boolean(),
  uiScale: z.number().min(0.5).max(3),
  handsFreeMode: z.boolean(),
  cancelVoice: z.object({ enabled: z.boolean(), phrases: shortText(500) }),
  tts: z.object({ enabled: z.boolean(), voice: shortText(40) }),
  showConfidence: z.boolean(),
  dwellClick: z.object({
    enabled: z.boolean(),
    dwellMs: z.number().int().min(200).max(10_000),
    cooldownMs: z.number().int().min(0).max(30_000)
  }),
  vad: z.object({
    silenceMs: z.number().int().min(200).max(10_000),
    maxWaitMs: z.number().int().min(1000).max(120_000),
    speechThreshold: z.number().min(0).max(1),
    maxRecordMs: z.number().int().min(1000).max(300_000).optional()
  }),
  guideAutoDismissOnMove: z.boolean(),
  historyExchanges: z.number().int().min(0).max(50)
})

export type ConfigV1 = z.infer<typeof configV1Schema>

/** Schema for a settings patch sent from the renderer: any subset of top-level keys, nested objects partial. */
export const configPatchSchema = z
  .object({
    theme: configV1Schema.shape.theme,
    themeCustom: configV1Schema.shape.themeCustom,
    models: configV1Schema.shape.models,
    hotkey: configV1Schema.shape.hotkey,
    hudAutoCloseMs: configV1Schema.shape.hudAutoCloseMs,
    answerAutoCloseMs: configV1Schema.shape.answerAutoCloseMs,
    wakeWord: configV1Schema.shape.wakeWord.partial(),
    statusBubble: configV1Schema.shape.statusBubble.partial(),
    voiceVocab: configV1Schema.shape.voiceVocab,
    historyEnabled: configV1Schema.shape.historyEnabled,
    explainBeforeDo: configV1Schema.shape.explainBeforeDo,
    uiScale: configV1Schema.shape.uiScale,
    handsFreeMode: configV1Schema.shape.handsFreeMode,
    cancelVoice: configV1Schema.shape.cancelVoice.partial(),
    tts: configV1Schema.shape.tts.partial(),
    showConfidence: configV1Schema.shape.showConfidence,
    dwellClick: configV1Schema.shape.dwellClick.partial(),
    vad: configV1Schema.shape.vad.partial(),
    guideAutoDismissOnMove: configV1Schema.shape.guideAutoDismissOnMove,
    historyExchanges: configV1Schema.shape.historyExchanges
  })
  .partial()
  .strict()

export type ConfigPatch = z.infer<typeof configPatchSchema>
