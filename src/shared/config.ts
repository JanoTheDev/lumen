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

// ---- a11y (06) ----

export const DWELL_CLICK_TYPES = ['left', 'right', 'double', 'drag'] as const
export const PAUSE_CORNERS = [
  'none',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
] as const

const a11ySwitchSchema = z.object({
  enabled: z.boolean(),
  /** auto = 1-switch auto-scan; step = switch A moves, switch B selects. */
  mode: z.enum(['auto', 'step']).default('auto'),
  scanIntervalMs: z.number().int().min(300).max(10_000).default(1500),
  /** Full passes over a group before auto-scan backs out. */
  loops: z.number().int().min(1).max(10).default(3),
  /** Key names used as switches (Space, Enter, F1-F12...): [select] or [next, select]. */
  keys: z.array(z.string().max(20)).max(4).default(['Space'])
})

const a11yTimingsSchema = z.object({
  /** Status bubble minimum on-screen time. */
  statusHoldMs: z.number().int().min(4000).max(600_000).default(4000),
  /** "I heard: …" caption; 0 = until the next utterance or dismissed. */
  captionHoldMs: z.number().int().min(0).max(600_000).default(0),
  /**
   * Confirm countdown before an action runs by itself; 0 = wait forever, unset = the app's
   * own countdown (2-4 s by confidence). Optional so the a11y profiles can set 0.
   */
  confirmCountdownMs: z.number().int().min(0).max(120_000).optional()
})

const a11yDwellSchema = z.object({
  clickType: z.enum(DWELL_CLICK_TYPES).default('left'),
  /** Palette choice stays for every dwell instead of only the next one. */
  sticky: z.boolean().default(false),
  /** Extra clicks in place before the cursor must leave the radius (0 = one click). */
  maxRepeats: z.number().int().min(0).max(10).default(0),
  /** Jitter radius in logical px. */
  radiusPx: z.number().min(4).max(80).default(12),
  /** Cursor smoothing (EMA alpha); 0 = off. */
  smoothing: z.number().min(0).max(0.9).default(0),
  snapToElement: z.boolean().default(false),
  /** Delete/Send/Buy… need a second dwell. */
  safeTargets: z.boolean().default(true),
  ringSize: z.enum(['s', 'm', 'l', 'xl']).default('m'),
  /** Dwelling in this screen corner toggles pause. */
  pauseCorner: z.enum(PAUSE_CORNERS).default('top-left'),
  /** Click-type palette window. */
  palette: z.boolean().default(false)
})

const a11yMarksSchema = z.object({
  /** Numbers stay on screen after an action (motor-voice profile). */
  keep: z.boolean().default(false),
  badgeSize: z.enum(['s', 'm', 'l']).default('m')
})

const shortcut = z.union([z.literal(''), z.string().regex(HOTKEY_RE)])

/**
 * Global shortcuts (06 T17); "" = none. Answer keys are bound only while an answer shows,
 * dwell pause only while dwell is on, lesson keys only while a lesson runs.
 */
const a11yShortcutsSchema = z.object({
  focusBar: shortcut.default('Ctrl+Shift+F2'),
  repeat: shortcut.default('Ctrl+Shift+F3'),
  pin: shortcut.default('Ctrl+Shift+F4'),
  close: shortcut.default('Ctrl+Shift+F5'),
  numbers: shortcut.default('Ctrl+Shift+F6'),
  grid: shortcut.default('Ctrl+Shift+F7'),
  dwellPause: shortcut.default('Ctrl+Shift+F8'),
  cancel: shortcut.default('Ctrl+Shift+F9'),
  keyboard: shortcut.default('Ctrl+Shift+F10'),
  lessonNext: shortcut.default('Ctrl+Alt+Right'),
  lessonBack: shortcut.default('Ctrl+Alt+Left'),
  lessonHelp: shortcut.default('Ctrl+Alt+H'),
  lessonDoIt: shortcut.default('Ctrl+Alt+D')
})

export type A11yShortcuts = z.infer<typeof a11yShortcutsSchema>
export type A11yShortcutAction = keyof A11yShortcuts

export const A11Y_DEFAULTS = {
  timings: { statusHoldMs: 4000, captionHoldMs: 0 },
  dwell: {
    clickType: 'left',
    sticky: false,
    maxRepeats: 0,
    radiusPx: 12,
    smoothing: 0,
    snapToElement: false,
    safeTargets: true,
    ringSize: 'm',
    pauseCorner: 'top-left',
    palette: false
  },
  marks: { keep: false, badgeSize: 'm' },
  switch: { enabled: false, mode: 'auto', scanIntervalMs: 1500, loops: 3, keys: ['Space'] },
  shortcuts: {
    focusBar: 'Ctrl+Shift+F2',
    repeat: 'Ctrl+Shift+F3',
    pin: 'Ctrl+Shift+F4',
    close: 'Ctrl+Shift+F5',
    numbers: 'Ctrl+Shift+F6',
    grid: 'Ctrl+Shift+F7',
    dwellPause: 'Ctrl+Shift+F8',
    cancel: 'Ctrl+Shift+F9',
    keyboard: 'Ctrl+Shift+F10',
    lessonNext: 'Ctrl+Alt+Right',
    lessonBack: 'Ctrl+Alt+Left',
    lessonHelp: 'Ctrl+Alt+H',
    lessonDoIt: 'Ctrl+Alt+D'
  }
} as const satisfies {
  timings: z.infer<typeof a11yTimingsSchema>
  dwell: z.infer<typeof a11yDwellSchema>
  marks: z.infer<typeof a11yMarksSchema>
  switch: z.infer<typeof a11ySwitchSchema>
  shortcuts: A11yShortcuts
}

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
    provider: z.enum(['auto', 'anthropic', 'openai', 'local']),
    /** Local OpenAI-compatible server (experimental); unset = auto-detect Ollama / LM Studio. */
    localUrl: z.union([z.literal(''), z.string().regex(/^https?:\/\/[^\s]{1,200}$/i)]).optional(),
    /** Local model name; unset = best installed vision model. */
    localModel: modelId.optional()
  }),
  hotkey: v1.hotkey,
  hudAutoCloseMs: v1.hudAutoCloseMs,
  answerAutoCloseMs: v1.answerAutoCloseMs,
  wakeWord: v1.wakeWord.extend({
    /**
     * Keyword spotter only: 0 = fewest false wakes, 1 = wakes most easily. Optional (no zod
     * default) so a partial patch never resets it; DEFAULT_CONFIG_V2 fills it on load.
     */
    sensitivity: z.number().min(0).max(1).optional()
  }),
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
    bargeIn: z.boolean(),
    /** Output muted when an answer would be spoken: also copy the answer to the clipboard. */
    copyWhenMuted: z.boolean().default(false),
    /** Speak answers even while a screen reader runs (off: answers go to the screen reader). */
    ttsWithScreenReader: z.boolean().default(false),
    /** Microphone deviceId from enumerateDevices; '' = the system default. */
    micDeviceId: z.string().max(200).optional()
  }),
  a11y: z.object({
    announce: z.enum(['auto', 'off']),
    uiScale: v1.uiScale,
    reduceMotion: z.enum(['system', 'on', 'off']),
    contrast: z.enum(['system', 'on', 'off']),
    captions: z.boolean(),
    switch: a11ySwitchSchema,
    voiceCommands: z.boolean(),
    // 06 additions. Nested fields default so older configs and partial patches stay valid;
    // a patch replaces a nested object as a whole (saveConfig merges one level deep).
    timings: a11yTimingsSchema.default(A11Y_DEFAULTS.timings),
    dwell: a11yDwellSchema.default(A11Y_DEFAULTS.dwell),
    marks: a11yMarksSchema.default(A11Y_DEFAULTS.marks),
    /** Speak the name/role of whatever gets keyboard focus (off when a screen reader runs). */
    focusNarration: z.boolean().default(false),
    /** Show "I heard: …" and wait for yes before actions: always, risky actions only, or off. */
    confirmTranscript: z.enum(['always', 'risky', 'off']).default('risky'),
    simpleMode: z.boolean().default(false),
    /** Profiles picked in onboarding / Settings (06 profiles.md ids). */
    profiles: z.array(z.string().max(30)).max(12).default([]),
    /** Opens the "what can I say" sheet; "" = no shortcut. Filled from the defaults on load. */
    helpHotkey: z.union([z.literal(''), z.string().regex(HOTKEY_RE)]).optional(),
    shortcuts: a11yShortcutsSchema.default(A11Y_DEFAULTS.shortcuts)
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
  /**
   * router "legacy" = the old regex classifier + prompt overrides (rollback switch).
   * maxSteps caps plan/research steps (default 8), maxFollowUps a follow-up chain (default 6).
   */
  ai: z.object({
    router: z.enum(['llm', 'legacy']),
    maxSteps: z.number().int().min(1).max(20).optional(),
    maxFollowUps: z.number().int().min(0).max(12).optional()
  }),
  /** Speak-to-type. hotkey "" = no dedicated hotkey; autoDetect = dictate from the main hotkey. */
  dictation: z.object({
    enabled: z.boolean(),
    hotkey: z.union([z.literal(''), z.string().regex(HOTKEY_RE)]),
    cleanup: z.enum(['light', 'off']),
    autoDetect: z.boolean(),
    terminal: z.enum(['type-no-enter', 'block']),
    dictionary: z.array(shortText(60)).max(500)
  }),
  /** v2 = assistant bar, per-display screen layer and panel window instead of the old windows. */
  ui: z.object({
    v2: z.boolean(),
    /** Opens the Home flyout from anywhere; "" = no shortcut. Optional so patches never reset it. */
    homeHotkey: z.union([z.literal(''), z.string().regex(HOTKEY_RE)]).optional()
  }),
  /** First-run setup finished (or skipped). */
  onboarding: z.object({ done: z.boolean() }),
  legacy: z.record(z.string(), z.unknown()).optional()
})

export type ConfigV2 = z.infer<typeof configV2Schema>

/** Matches the evaluated spotter tuning (boost 5, threshold 0.1). */
export const WAKE_SENSITIVITY_DEFAULT = 0.5

// New sections default to off/neutral so a migrated install behaves exactly like v1.
export const DEFAULT_CONFIG_V2: ConfigV2 = {
  version: 2,
  agentImpl: 'auto',
  theme: DEFAULT_CONFIG_V1.theme,
  models: { provider: 'auto' },
  hotkey: DEFAULT_CONFIG_V1.hotkey,
  hudAutoCloseMs: DEFAULT_CONFIG_V1.hudAutoCloseMs,
  answerAutoCloseMs: DEFAULT_CONFIG_V1.answerAutoCloseMs,
  wakeWord: { ...DEFAULT_CONFIG_V1.wakeWord, sensitivity: WAKE_SENSITIVITY_DEFAULT },
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
  voice: {
    stt: 'local',
    tts: 'off',
    ttsVoice: 'alloy',
    ttsRate: 1,
    bargeIn: false,
    copyWhenMuted: false,
    ttsWithScreenReader: false,
    micDeviceId: ''
  },
  a11y: {
    announce: 'off',
    uiScale: 1,
    reduceMotion: 'system',
    contrast: 'system',
    captions: false,
    switch: { ...A11Y_DEFAULTS.switch, keys: [...A11Y_DEFAULTS.switch.keys] },
    // The local grammar is anchored and exact-match, so it is safe to run for everyone.
    voiceCommands: true,
    timings: { ...A11Y_DEFAULTS.timings },
    dwell: { ...A11Y_DEFAULTS.dwell },
    marks: { ...A11Y_DEFAULTS.marks },
    focusNarration: false,
    confirmTranscript: 'risky',
    simpleMode: false,
    profiles: [],
    helpHotkey: 'Ctrl+Shift+F1',
    shortcuts: { ...A11Y_DEFAULTS.shortcuts }
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
  ai: { router: 'llm' },
  dictation: {
    enabled: true,
    hotkey: 'Ctrl+Shift+D',
    cleanup: 'light',
    autoDetect: true,
    terminal: 'type-no-enter',
    dictionary: []
  },
  ui: { v2: false, homeHotkey: 'Ctrl+Shift+H' },
  onboarding: { done: false }
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

const patchObject = z
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
    ai: s2.ai.partial().strict(),
    dictation: s2.dictation.partial().strict(),
    ui: s2.ui.partial().strict(),
    onboarding: s2.onboarding.partial().strict()
  })
  .partial()
  .strict()

// zod fills `.default()` fields into partial objects, which would reset settings the patch
// never mentioned; keep only the keys the patch actually sent.
function keepGiven(input: unknown, out: unknown): unknown {
  if (!isPlainObject(input) || !isPlainObject(out)) return out
  const res: Record<string, unknown> = {}
  for (const k of Object.keys(input)) if (k in out) res[k] = keepGiven(input[k], out[k])
  return res
}

/** Schema for a settings patch sent from the renderer: any subset of top-level v2 keys, nested objects partial. */
export const configPatchSchema = z.unknown().transform((input, ctx) => {
  const r = patchObject.safeParse(input)
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue(issue as Parameters<typeof ctx.addIssue>[0])
    return z.NEVER
  }
  return keepGiven(input, r.data) as z.infer<typeof patchObject>
})

export type ConfigPatch = z.infer<typeof configPatchSchema>
