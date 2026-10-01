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
  'system',
  'dark',
  'light',
  'high-contrast',
  'ocean',
  'forest',
  'sunset',
  'midnight',
  'custom'
] as const

export const ACCENT_IDS = ['blue', 'teal', 'green', 'orange', 'pink', 'violet', 'yellow'] as const

export const configV1Schema = z.object({
  version: z.literal(1),
  theme: z.enum(THEME_NAMES),
  themeCustom: z
    .object({
      accent: hex,
      background: hex,
      foreground: hex,
      opacity: z.number().min(0).max(1).optional(),
      blur: z.number().min(0).max(64).optional()
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

export const DEFAULT_CONFIG_V1: ConfigV1 = {
  version: 1,
  theme: 'dark',
  models: {},
  hotkey: 'Ctrl+Shift+Space',
  hudAutoCloseMs: 5000,
  answerAutoCloseMs: 10000,
  wakeWord: { enabled: false, phrase: 'hey lumen' },
  statusBubble: { enabled: true },
  voiceVocab: '',
  historyEnabled: true,
  explainBeforeDo: true,
  uiScale: 1,
  handsFreeMode: false,
  cancelVoice: { enabled: false, phrases: 'stop, cancel, abort, never mind' },
  tts: { enabled: false, voice: 'alloy' },
  showConfidence: false,
  dwellClick: { enabled: false, dwellMs: 1400, cooldownMs: 1500 },
  vad: { silenceMs: 1500, maxWaitMs: 8000, speechThreshold: 0.04 },
  guideAutoDismissOnMove: false,
  historyExchanges: 5
}

// ---- v2 (C7) ----
// Settings without a dedicated v2 section stay at the top level under their v1 names.

const v1 = configV1Schema.shape

export const configV2Schema = z.object({
  version: z.literal(2),
  agentImpl: z.enum(['auto', 'python', 'native']),
  theme: v1.theme,
  themeCustom: v1.themeCustom,
  /** Accent preset id (blue, teal, …) or #RRGGBB; unset = theme default. */
  accent: z.union([z.enum(ACCENT_IDS), hex]).optional(),
  models: z.object({
    main: modelId.optional(),
    fast: modelId.optional(),
    planning: modelId.optional(),
    verify: modelId.optional(),
    provider: z.enum(['auto', 'anthropic', 'openai', 'local'])
  }),
  hotkey: v1.hotkey,
  hudAutoCloseMs: v1.hudAutoCloseMs,
  answerAutoCloseMs: v1.answerAutoCloseMs,
  wakeWord: v1.wakeWord,
  statusBubble: v1.statusBubble,
  voiceVocab: v1.voiceVocab,
  historyEnabled: v1.historyEnabled,
  historyExchanges: v1.historyExchanges,
  explainBeforeDo: v1.explainBeforeDo,
  handsFreeMode: v1.handsFreeMode,
  cancelVoice: v1.cancelVoice,
  showConfidence: v1.showConfidence,
  dwellClick: v1.dwellClick,
  vad: v1.vad,
  guideAutoDismissOnMove: v1.guideAutoDismissOnMove,
  voice: z.object({
    stt: z.enum(['cloud-stream', 'cloud-batch', 'local']),
    tts: z.enum(['cloud', 'windows', 'off']),
    ttsVoice: shortText(40),
    ttsRate: z.number().min(0.25).max(4),
    bargeIn: z.boolean()
  }),
  a11y: z.object({
    announce: z.enum(['auto', 'off']),
    uiScale: v1.uiScale,
    reduceMotion: z.enum(['system', 'on', 'off']),
    contrast: z.enum(['system', 'on', 'off']),
    captions: z.boolean(),
    switch: z.object({ enabled: z.boolean() }),
    voiceCommands: z.boolean()
  }),
  buddy: z.object({
    enabled: z.boolean(),
    color: shortText(20),
    size: z.enum(['s', 'm', 'l']),
    followCursor: z.boolean()
  }),
  agent: z.object({
    confirm: z.enum(['always', 'risky', 'never']),
    cancelWindowMs: z.number().int().min(0).max(30_000)
  }),
  privacy: z.object({ saveScreenshots: z.boolean(), telemetry: z.boolean() }),
  teach: z.object({
    activeSkill: z.string().max(80).nullable(),
    hintLevel: z.enum(['auto', 'minimal', 'detailed'])
  }),
  memory: z.object({
    enabled: z.boolean(),
    autoLearn: z.enum(['auto', 'ask', 'off']),
    retentionDays: z.number().int().min(1).max(3650),
    maxInjectTokens: z.number().int().min(0).max(8000),
    privateMode: z.boolean()
  }),
  /** router "legacy" = the old regex classifier + prompt overrides (rollback switch). */
  ai: z.object({ router: z.enum(['llm', 'legacy']) }),
  legacy: z.record(z.string(), z.unknown()).optional()
})

export type ConfigV2 = z.infer<typeof configV2Schema>

// New sections default to off/neutral so a migrated install behaves exactly like v1.
export const DEFAULT_CONFIG_V2: ConfigV2 = {
  version: 2,
  agentImpl: 'auto',
  theme: DEFAULT_CONFIG_V1.theme,
  models: { provider: 'auto' },
  hotkey: DEFAULT_CONFIG_V1.hotkey,
  hudAutoCloseMs: DEFAULT_CONFIG_V1.hudAutoCloseMs,
  answerAutoCloseMs: DEFAULT_CONFIG_V1.answerAutoCloseMs,
  wakeWord: { ...DEFAULT_CONFIG_V1.wakeWord },
  statusBubble: { ...DEFAULT_CONFIG_V1.statusBubble },
  voiceVocab: DEFAULT_CONFIG_V1.voiceVocab,
  historyEnabled: DEFAULT_CONFIG_V1.historyEnabled,
  historyExchanges: DEFAULT_CONFIG_V1.historyExchanges,
  explainBeforeDo: DEFAULT_CONFIG_V1.explainBeforeDo,
  handsFreeMode: DEFAULT_CONFIG_V1.handsFreeMode,
  cancelVoice: { ...DEFAULT_CONFIG_V1.cancelVoice },
  showConfidence: DEFAULT_CONFIG_V1.showConfidence,
  dwellClick: { ...DEFAULT_CONFIG_V1.dwellClick },
  vad: { ...DEFAULT_CONFIG_V1.vad },
  guideAutoDismissOnMove: DEFAULT_CONFIG_V1.guideAutoDismissOnMove,
  voice: { stt: 'cloud-batch', tts: 'off', ttsVoice: 'alloy', ttsRate: 1, bargeIn: false },
  a11y: {
    announce: 'off',
    uiScale: 1,
    reduceMotion: 'system',
    contrast: 'system',
    captions: false,
    switch: { enabled: false },
    voiceCommands: false
  },
  buddy: { enabled: false, color: 'accent', size: 'm', followCursor: true },
  agent: { confirm: 'risky', cancelWindowMs: 3000 },
  privacy: { saveScreenshots: false, telemetry: false },
  teach: { activeSkill: null, hintLevel: 'auto' },
  memory: {
    enabled: false,
    autoLearn: 'ask',
    retentionDays: 365,
    maxInjectTokens: 1200,
    privateMode: false
  },
  ai: { router: 'llm' }
}

const V1_KEYS = new Set(Object.keys(configV1Schema.shape))
const V2_KEYS = new Set(Object.keys(configV2Schema.shape))

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Maps a v1 (or version-less) config object onto the v2 layout. Unknown keys go to `legacy`. */
export function migrateV1toV2(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 2 }
  const legacy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    if (!V1_KEYS.has(key)) legacy[key] = value
    else if (!['version', 'models', 'uiScale', 'tts'].includes(key)) out[key] = value
  }
  const models = isPlainObject(src.models) ? src.models : {}
  const nextModels: Record<string, unknown> = { provider: 'auto' }
  if (models.planning !== undefined) nextModels.planning = models.planning
  if (models.execution !== undefined) nextModels.main = models.execution
  if (models.verification !== undefined) nextModels.verify = models.verification
  out.models = nextModels
  if (src.uiScale !== undefined) out.a11y = { uiScale: src.uiScale }
  if (isPlainObject(src.tts)) {
    const voice: Record<string, unknown> = {}
    if (typeof src.tts.enabled === 'boolean') voice.tts = src.tts.enabled ? 'cloud' : 'off'
    if (src.tts.voice !== undefined) voice.ttsVoice = src.tts.voice
    out.voice = voice
  }
  if (Object.keys(legacy).length) out.legacy = legacy
  return out
}

/** Fills missing fields from DEFAULT_CONFIG_V2, merging nested sections one level deep. Unknown keys go to `legacy`. */
export function withV2Defaults(partial: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG_V2 }
  const legacy: Record<string, unknown> = isPlainObject(partial.legacy) ? { ...partial.legacy } : {}
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'legacy' || key === 'version' || value === undefined) continue
    if (!V2_KEYS.has(key)) {
      legacy[key] = value
      continue
    }
    const def = (DEFAULT_CONFIG_V2 as Record<string, unknown>)[key]
    out[key] = isPlainObject(def) && isPlainObject(value) ? { ...def, ...value } : value
  }
  if (Object.keys(legacy).length) out.legacy = legacy
  return out
}

const s2 = configV2Schema.shape

/** Schema for a settings patch sent from the renderer: any subset of top-level v2 keys, nested objects partial. */
export const configPatchSchema = z
  .object({
    agentImpl: s2.agentImpl,
    theme: s2.theme,
    themeCustom: s2.themeCustom,
    accent: s2.accent,
    models: s2.models.partial().strict(),
    hotkey: s2.hotkey,
    hudAutoCloseMs: s2.hudAutoCloseMs,
    answerAutoCloseMs: s2.answerAutoCloseMs,
    wakeWord: s2.wakeWord.partial().strict(),
    statusBubble: s2.statusBubble.partial().strict(),
    voiceVocab: s2.voiceVocab,
    historyEnabled: s2.historyEnabled,
    historyExchanges: s2.historyExchanges,
    explainBeforeDo: s2.explainBeforeDo,
    handsFreeMode: s2.handsFreeMode,
    cancelVoice: s2.cancelVoice.partial().strict(),
    showConfidence: s2.showConfidence,
    dwellClick: s2.dwellClick.partial().strict(),
    vad: s2.vad.partial().strict(),
    guideAutoDismissOnMove: s2.guideAutoDismissOnMove,
    voice: s2.voice.partial().strict(),
    a11y: s2.a11y.partial().strict(),
    buddy: s2.buddy.partial().strict(),
    agent: s2.agent.partial().strict(),
    privacy: s2.privacy.partial().strict(),
    teach: s2.teach.partial().strict(),
    memory: s2.memory.partial().strict(),
    ai: s2.ai.partial().strict()
  })
  .partial()
  .strict()

export type ConfigPatch = z.infer<typeof configPatchSchema>
