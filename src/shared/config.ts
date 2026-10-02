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

// One key, no modifiers: a switch key (06 T09). Names both the native hook and Electron's
// globalShortcut fallback accept.
const SWITCH_KEY_NAMES = [
  'Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right',
  'Capslock|Numlock|Scrolllock|num[0-9]|numadd|numsub|nummult|numdiv|numdec',
  'VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause'
].join('|')
export const SWITCH_KEY_RE = new RegExp(
  `^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|${SWITCH_KEY_NAMES})$`,
  'i'
)

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

/** Voice languages with a confirm/stop lexicon (src/main/speech/lexicon); auto = detect. */
export const VOICE_LANGUAGES = ['auto', 'en', 'es', 'de', 'fr', 'it', 'pt', 'nl'] as const
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]

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
  keys: z.array(z.string().max(20).regex(SWITCH_KEY_RE)).max(4).default(['Space'])
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

/** Living with Voice Access / Dragon (06 T20). */
const a11yCoexistSchema = z.object({
  /** While Voice Access or Dragon runs, Lumen leaves shared commands to it unless "Lumen …". */
  yieldToVoiceControl: z.boolean().default(true),
  /** Keep the wake word listening while Dragon runs (off: Dragon owns the microphone). */
  wakeWithDragon: z.boolean().default(false)
})

// ---- face gestures (11 T25) ----

/** Facial gestures the camera can see (MediaPipe Face Landmarker blendshapes + head pose). */
export const FACE_GESTURES = [
  'mouthOpen',
  'browRaise',
  'smile',
  'tiltLeft',
  'tiltRight',
  'turnLeft',
  'turnRight'
] as const
export type FaceGesture = (typeof FACE_GESTURES)[number]

/** What a gesture does: a click or scroll at the pointer, a switch press, dwell pause, voice. */
export const FACE_ACTIONS = [
  'none',
  'click',
  'right-click',
  'double-click',
  'scroll-up',
  'scroll-down',
  'switch-select',
  'switch-next',
  'dwell-pause',
  'voice'
] as const
export type FaceAction = (typeof FACE_ACTIONS)[number]

const faceActionSchema = z.enum(FACE_ACTIONS).default('none')

/**
 * A calibrated gesture: active when score * dir >= on, re-armed below rest + 70% of the gap.
 * Scores are 0..1 blendshapes or head angles in degrees.
 */
export const faceThresholdSchema = z.object({
  on: z.number().min(-90).max(90),
  rest: z.number().min(-90).max(90),
  dir: z.union([z.literal(1), z.literal(-1)])
})
export type FaceThreshold = z.infer<typeof faceThresholdSchema>

const a11yFaceSchema = z.object({
  /** Camera on and gestures live. Off: the camera is closed and nothing runs. */
  enabled: z.boolean().default(false),
  bindings: z
    .object({
      mouthOpen: faceActionSchema,
      browRaise: faceActionSchema,
      smile: faceActionSchema,
      tiltLeft: faceActionSchema,
      tiltRight: faceActionSchema,
      turnLeft: faceActionSchema,
      turnRight: faceActionSchema
    })
    .default({
      mouthOpen: 'click',
      browRaise: 'scroll-down',
      smile: 'none',
      tiltLeft: 'none',
      tiltRight: 'switch-select',
      turnLeft: 'none',
      turnRight: 'none'
    }),
  /** Calibrated thresholds; a missing gesture uses the built-in default. */
  thresholds: z
    .object({
      mouthOpen: faceThresholdSchema.optional(),
      browRaise: faceThresholdSchema.optional(),
      smile: faceThresholdSchema.optional(),
      tiltLeft: faceThresholdSchema.optional(),
      tiltRight: faceThresholdSchema.optional(),
      turnLeft: faceThresholdSchema.optional(),
      turnRight: faceThresholdSchema.optional()
    })
    .default({}),
  /** How long a gesture must be held before it acts. */
  holdMs: z.number().int().min(50).max(3000).default(300),
  /** Quiet time after a gesture acted. */
  cooldownMs: z.number().int().min(100).max(10_000).default(800),
  /** Camera deviceId from enumerateDevices; '' = the system default. */
  cameraId: z.string().max(200).default('')
})
export type FaceConfig = z.infer<typeof a11yFaceSchema>

export const FACE_DEFAULTS: FaceConfig = {
  enabled: false,
  bindings: {
    mouthOpen: 'click',
    browRaise: 'scroll-down',
    smile: 'none',
    tiltLeft: 'none',
    tiltRight: 'switch-select',
    turnLeft: 'none',
    turnRight: 'none'
  },
  thresholds: {},
  holdMs: 300,
  cooldownMs: 800,
  cameraId: ''
}

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

export const READING_LEVELS = ['plain', 'standard', 'expert'] as const
export type ReadingLevel = (typeof READING_LEVELS)[number]

/**
 * Helpers (11 Phase C): focus mode, undo, shortcut coach, fatigue proposals, error rescue,
 * "what changed?", reading level and the learning journal. Undo is on by default, the rest
 * are opt-in. Everything stays local.
 */
const helpersSchema = z.object({
  /** How strongly focus mode dims the rest of the screen. */
  focusLevel: z.enum(['soft', 'strong']),
  /** Turn focus mode on by itself while a lesson step shows its target. */
  focusWithLessons: z.boolean(),
  /** Keep how to reverse Lumen's actions ("undo that"). Memory only, plus file copies. */
  undo: z.boolean(),
  shortcutCoach: z.boolean(),
  /** keys: suggest the key combo; voice: suggest a voice command instead of a chord. */
  coachMode: z.enum(['keys', 'voice']),
  /** Menu uses before the first tip. */
  coachAfter: z.number().int().min(2).max(10),
  fatigue: z.boolean(),
  errorRescue: z.boolean(),
  /** UIA snapshot + low-res screenshot at each command, for "what changed?". */
  whatChanged: z.boolean(),
  readingLevel: z.enum(READING_LEVELS),
  /** Per-app reading level by app-pack id; overrides readingLevel. */
  readingLevelApps: z
    .record(z.string().max(80), z.enum(READING_LEVELS))
    .refine((o) => Object.keys(o).length <= 100, 'too many apps'),
  journal: z.boolean(),
  /** "click this", "move this there": the pointer is watched (memory, 10 s) while on. */
  deictic: z.boolean(),
  /** Speak and target unnamed controls by their saved community labels. */
  labels: z.boolean()
})

export type HelpersConfig = z.infer<typeof helpersSchema>

export const HELPERS_DEFAULTS: HelpersConfig = {
  focusLevel: 'soft',
  focusWithLessons: false,
  undo: true,
  shortcutCoach: false,
  coachMode: 'keys',
  coachAfter: 3,
  fatigue: false,
  errorRescue: false,
  whatChanged: false,
  readingLevel: 'standard',
  readingLevelApps: {},
  journal: false,
  deictic: false,
  labels: true
}

/** Dictation styles (04 T36): punctuation and capitals only, never words. */
export const DICTATION_STYLES = ['formal', 'casual', 'very-casual', 'code', 'off'] as const
export type DictationStyle = (typeof DICTATION_STYLES)[number]
/** Kinds of app a dictation style is chosen for (from the focused process or page title). */
export const DICTATION_APP_KINDS = ['email', 'work', 'personal', 'docs', 'code', 'other'] as const
export type DictationAppKind = (typeof DICTATION_APP_KINDS)[number]
export const DICTATION_STYLE_DEFAULTS: Record<DictationAppKind, DictationStyle> = {
  email: 'formal',
  work: 'casual',
  personal: 'casual',
  docs: 'formal',
  code: 'code',
  other: 'off'
}
const dictationStyle = z.enum(DICTATION_STYLES)

/**
 * Read the web with me (05 Phase W): news feeds (free publisher RSS / Atom, user-editable),
 * interests that rank stories, and the opt-in paid web search (off by default; a per-search
 * price applies on the user's own key).
 */
const newsFeedSchema = z.object({
  name: z.string().min(1).max(60),
  url: z
    .string()
    .max(500)
    .regex(/^https:\/\/[^\s/]+\.[^\s]+$/, 'https feed address'),
  topic: z.string().max(30)
})

const webSchema = z.object({
  feeds: z.array(newsFeedSchema).max(40),
  /** Topics that rank news higher ("climate", "formula 1"). */
  interests: z.array(shortText(60)).max(30),
  /** Paid provider web search for "news about X" and questions the feeds can't answer. */
  paidSearch: z.boolean()
})

export type NewsFeedConfig = z.infer<typeof newsFeedSchema>
export type WebConfig = z.infer<typeof webSchema>

export const WEB_DEFAULTS: WebConfig = {
  feeds: [
    { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', topic: 'world' },
    { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', topic: 'world' },
    { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', topic: 'world' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', topic: 'tech' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', topic: 'tech' },
    { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', topic: 'tech' }
  ],
  interests: [],
  paidSearch: false
}

/**
 * Usage limits (05 T45): optional monthly caps from the usage ledger, overall and per automation
 * (USD; tokens = input + output, for free or local models). 0 or unset = no cap. At 80% one
 * Tasks notice; at 100% automation and buddy runs pause until the next month (questions the user
 * asks are never blocked). Buddy caps live in each buddy's budget.
 */
const usageCapSchema = z.object({
  usd: z.number().min(0).max(100_000).optional(),
  tokens: z.number().int().min(0).max(1_000_000_000_000).optional()
})

const usageSchema = z.object({
  limits: z.object({
    monthlyUsd: z.number().min(0).max(100_000).optional(),
    monthlyTokens: z.number().int().min(0).max(1_000_000_000_000).optional(),
    /** Per automation id. */
    automations: z.record(z.string().regex(/^[a-z]{2}_[a-z0-9]{4,40}$/), usageCapSchema).default({})
  })
})

export type UsageLimitsConfig = z.infer<typeof usageSchema>['limits']

export const USAGE_DEFAULTS: z.infer<typeof usageSchema> = { limits: { automations: {} } }

/** Backends a role can use. `auto` follows models.provider. */
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'gemini', 'compatible', 'local'] as const
export type ModelProvider = (typeof MODEL_PROVIDERS)[number]

/** Presets of the generic OpenAI-compatible provider (base URLs in main/ai/providers/compatible). */
export const COMPATIBLE_PRESETS = [
  'openrouter',
  'groq',
  'mistral',
  'deepseek',
  'together',
  'custom'
] as const
export type CompatiblePreset = (typeof COMPATIBLE_PRESETS)[number]

/** https anywhere, plain http only on this PC. */
export const SERVICE_URL_RE =
  /^(https:\/\/[^\s]{1,200}|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]{0,200})?)$/i

const roleChoice = z.object({
  provider: z.enum(['auto', ...MODEL_PROVIDERS]),
  /** Empty = that provider's default model for the role. */
  model: modelId.optional()
})

export const configV2Schema = z.object({
  version: z.literal(2),
  theme: v1.theme,
  themeCustom: v1.themeCustom,
  /** Accent preset id (blue, teal, …) or #RRGGBB; unset = theme default. */
  accent: z.union([z.enum(ACCENT_IDS), hex]).optional(),
  models: z.object({
    main: modelId.optional(),
    fast: modelId.optional(),
    planning: modelId.optional(),
    verify: modelId.optional(),
    provider: z.enum(['auto', ...MODEL_PROVIDERS]),
    /** Local OpenAI-compatible server (experimental); unset = auto-detect Ollama / LM Studio. */
    localUrl: z.union([z.literal(''), z.string().regex(/^https?:\/\/[^\s]{1,200}$/i)]).optional(),
    /** Local model name; unset = best installed vision model. */
    localModel: modelId.optional(),
    /** Never call a cloud model: cloud keys are set aside while on. */
    localOnly: z.boolean().optional(),
    /** Local only may also use a localUrl on the home network (else this PC only). */
    localLan: z.boolean().optional(),
    /** The user read the Gemini free-tier privacy note (data use, human review, 18+). */
    geminiAck: z.boolean().optional(),
    /** The Gemini key has billing on: calls count at the paid rates, not as free tier. */
    geminiPaid: z.boolean().optional(),
    /** The generic OpenAI-compatible service; its key lives in the key vault. */
    compatible: z
      .object({
        preset: z.enum(COMPATIBLE_PRESETS),
        /** Custom preset only (presets carry their own). */
        baseUrl: z.union([z.literal(''), z.string().regex(SERVICE_URL_RE)]).optional(),
        /** Model for roles that pick this service without naming one. */
        model: modelId.optional()
      })
      .optional(),
    /** Per-role provider + model (Settings → Models & keys); unset roles follow `provider`. */
    roles: z
      .object({
        main: roleChoice.optional(),
        fast: roleChoice.optional(),
        planning: roleChoice.optional(),
        vision: roleChoice.optional()
      })
      .optional()
  }),
  hotkey: v1.hotkey,
  answerAutoCloseMs: v1.answerAutoCloseMs,
  wakeWord: v1.wakeWord.extend({
    /**
     * Keyword spotter only: 0 = fewest false wakes, 1 = wakes most easily. Optional (no zod
     * default) so a partial patch never resets it; DEFAULT_CONFIG_V2 fills it on load.
     */
    sensitivity: z.number().min(0).max(1).optional()
  }),
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
    micDeviceId: z.string().max(200).optional(),
    /** Spoken language: STT language, reply language and lexicons; auto = detect (cloud only). */
    language: z.enum(VOICE_LANGUAGES).default('en'),
    /** Double-tapping the assistant hotkey starts a conversation: every utterance is a query. */
    conversation: z.boolean().default(true),
    /** Whisper mode (04 T40): quiet speech gets more gain and a lower speech threshold. */
    whisperMode: z.boolean().default(false)
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
    shortcuts: a11yShortcutsSchema.default(A11Y_DEFAULTS.shortcuts),
    coexist: a11yCoexistSchema.default({ yieldToVoiceControl: true, wakeWithDragon: false }),
    /** Face-gesture input (11 T25), off by default. */
    face: a11yFaceSchema.default(FACE_DEFAULTS)
  }),
  buddy: z.object({
    enabled: z.boolean(),
    color: shortText(20),
    size: z.enum(['s', 'm', 'l']),
    followCursor: z.boolean()
  }),
  agent: z.object({
    confirm: z.enum(['always', 'risky', 'never']),
    cancelWindowMs: z.number().int().min(0).max(30_000),
    /**
     * Safety-policy §4: sending a message (Send button, Ctrl+Enter in a chat) is high risk and
     * waits for an explicit yes. On: it is medium, so the cancel-window countdown runs instead.
     */
    allowSendWithoutReview: z.boolean().default(false),
    /**
     * lookup_howto (05 T36): auto = learned notes, free docs, then the provider's paid web search
     * when `web.paidSearch` is on (2 searches a task, 10 a day); free-only; off.
     */
    howtoLookup: z.enum(['auto', 'free-only', 'off']).default('auto'),
    /** Background tasks (08 T26–T29): concurrency, per-task caps, granted folders, quiet. */
    background: z
      .object({
        max: z.number().int().min(1).max(3),
        maxModelCalls: z.number().int().min(1).max(200),
        maxCostUsd: z.number().min(0.01).max(5),
        maxWallMin: z.number().int().min(1).max(120),
        /** Folders read_file may read (besides a skill's own grants). */
        readFolders: z.array(z.string().max(260)).max(20),
        /** Quiet mode: finished tasks wait in the list, nothing is spoken. */
        quiet: z.boolean()
      })
      .default({
        max: 3,
        maxModelCalls: 30,
        maxCostUsd: 0.25,
        maxWallMin: 15,
        readFolders: [],
        quiet: false
      }),
    /**
     * Sub-agents (08 T49): run_subagents jobs at once (outside the background slots), their
     * model role and the cost cap of each job (it also counts toward the parent's cap).
     */
    subagents: z
      .object({
        max: z.number().int().min(1).max(6),
        model: z.enum(['fast', 'main']),
        costCapUsd: z.number().min(0.01).max(1)
      })
      .default({ max: 4, model: 'fast', costCapUsd: 0.05 }),
    /**
     * Proactive mode (08 T23): opt-in, local only. `rules`: "when I open <app>, say <text>"
     * (the foreground app is watched only while enabled and a rule exists).
     */
    proactive: z
      .object({
        enabled: z.boolean(),
        rules: z
          .array(
            z
              .object({
                id: z.string().regex(/^pr_[a-z0-9]{4,40}$/),
                app: z.string().trim().min(2).max(60),
                say: z.string().trim().min(1).max(200)
              })
              .strict()
          )
          .max(20)
      })
      .default({ enabled: false, rules: [] })
  }),
  privacy: z.object({ saveScreenshots: z.boolean(), telemetry: z.boolean() }),
  /**
   * Action audit log (08 T04): days of ~/.ai-overlay/audit kept, and whether typed text is kept
   * (secrets and passwords redacted). Off: only its length and SHA-256.
   */
  audit: z
    .object({
      retentionDays: z.number().int().min(1).max(365),
      storeTypedText: z.boolean()
    })
    .default({ retentionDays: 30, storeTypedText: false }),
  teach: z.object({
    activeSkill: z.string().max(80).nullable(),
    hintLevel: z.enum(['auto', 'minimal', 'detailed']),
    /** Offer a due lesson review when its app is opened, at most once a day (07 T29). */
    reviewReminders: z.boolean(),
    /** Opt-in idle hints (07 T33): off by default; no screenshots outside a lesson. */
    idleHint: z.boolean(),
    /** Skill ids idle hints are on for; empty = every app. */
    idleHintApps: z.array(z.string().max(80)).max(50),
    idleHintSec: z.number().int().min(5).max(300),
    /** Speak idle hints (else bar caption only). */
    idleHintVoice: z.boolean()
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
    maxFollowUps: z.number().int().min(0).max(12).optional(),
    /** Reply style ("mode") in use: a `kind: style` skill and its level; null / unset = none. */
    style: z
      .object({
        name: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .max(64),
        level: z.string().max(30).optional()
      })
      .nullable()
      .optional()
  }),
  /** Speak-to-type. hotkey "" = no dedicated hotkey; autoDetect = dictate from the main hotkey. */
  dictation: z.object({
    enabled: z.boolean(),
    /** Spoken self-corrections ("Tuesday, actually Wednesday") are applied (04 T34). */
    backtrack: z.boolean().default(true),
    /** Lists, numbers, emails and spoken line breaks are formatted after cleanup (04 T35). */
    format: z.boolean().default(true),
    /** Style per kind of app (04 T36); styleApps puts a process or site word in a kind. */
    styles: z
      .object({
        email: dictationStyle,
        work: dictationStyle,
        personal: dictationStyle,
        docs: dictationStyle,
        code: dictationStyle,
        other: dictationStyle
      })
      .default(DICTATION_STYLE_DEFAULTS),
    styleApps: z
      .record(z.string().min(1).max(80), z.enum(DICTATION_APP_KINDS))
      .refine((o) => Object.keys(o).length <= 100, 'at most 100 apps')
      .default({}),
    /** With text selected, an edit command ("make this shorter") rewrites it (04 T37). */
    commandMode: z.boolean().default(true),
    /** Saved snippets expand when their phrase is said (04 T38). */
    snippets: z.boolean().default(true),
    /** Short start / stop sounds while dictating (04 T47); quiet mode silences them. */
    sounds: z.boolean().default(true),
    /** The dictation pill shows next to the text caret instead of the bottom bar (04 T47). */
    caretPill: z.boolean().default(true),
    /** Lower the system volume while dictating, restored afterwards (04 T47). */
    duckMedia: z.boolean().default(false),
    /** "… press enter" / "… send it" at the end presses Enter, never in terminals (04 T47/T48). */
    spokenKeys: z.boolean().default(true),
    /** Hands-free dictation ends after this many seconds of silence (04 T48). */
    silenceSec: z.number().min(1).max(10).default(2),
    /** Hold this mouse button to dictate (04 T48). */
    mouseButton: z.enum(['off', 'middle', 'x1', 'x2']).default('off'),
    hotkey: z.union([z.literal(''), z.string().regex(HOTKEY_RE)]),
    cleanup: z.enum(['light', 'off']),
    autoDetect: z.boolean(),
    terminal: z.enum(['type-no-enter', 'block']),
    dictionary: z.array(shortText(60)).max(500),
    /** Keep a local history of dictations (04 T44); off = nothing stored. */
    history: z.boolean().optional(),
    /** Show the dictation stats card in Home (04 T46). */
    showStats: z.boolean().optional(),
    /** Extra dictionary terms per app: a process or site word → terms (04 T39). */
    appDictionary: z
      .record(z.string().min(1).max(80), z.array(shortText(60)).max(200))
      .refine((o) => Object.keys(o).length <= 100, 'at most 100 apps')
      .default({}),
    /** "Spell as" rules: what the recogniser hears → how it is written (04 T39). */
    spellAs: z
      .array(z.object({ from: z.string().min(1).max(60), to: z.string().min(1).max(60) }))
      .max(300)
      .default([]),
    /** Names visible in the focused window fix dictated spellings; local only (04 T41). */
    screenNames: z.boolean().default(false),
    /** In code editors and terminals: "camel case …", spoken symbols, "at file …" (04 T42). */
    codingMode: z.boolean().default(true)
  }),
  ui: z.object({
    /** Opens the Home flyout from anywhere; "" = no shortcut. Optional so patches never reset it. */
    homeHotkey: z.union([z.literal(''), z.string().regex(HOTKEY_RE)]).optional()
  }),
  /** First-run setup finished (or skipped). */
  onboarding: z.object({ done: z.boolean() }),
  /**
   * Windows integration: start Lumen when the user signs in (ignored in the portable build);
   * autoUpdate: daily check, background download, install on quit (installed build only).
   */
  system: z.object({ startAtLogin: z.boolean(), autoUpdate: z.boolean() }),
  helpers: helpersSchema.default(HELPERS_DEFAULTS),
  web: webSchema.default(WEB_DEFAULTS),
  usage: usageSchema.default(USAGE_DEFAULTS),
  /** Developer aids (10 T11b): perfOverlay shows the last turn's stage timings in Settings. */
  debug: z.object({ perfOverlay: z.boolean() }).default({ perfOverlay: false }),
  legacy: z.record(z.string(), z.unknown()).optional()
})

export type ConfigV2 = z.infer<typeof configV2Schema>

/** Matches the evaluated spotter tuning (boost 5, threshold 0.1). */
export const WAKE_SENSITIVITY_DEFAULT = 0.5

// New sections default to off/neutral so a migrated install behaves exactly like v1.
export const DEFAULT_CONFIG_V2: ConfigV2 = {
  version: 2,
  theme: DEFAULT_CONFIG_V1.theme,
  models: { provider: 'auto' },
  hotkey: DEFAULT_CONFIG_V1.hotkey,
  answerAutoCloseMs: DEFAULT_CONFIG_V1.answerAutoCloseMs,
  wakeWord: { ...DEFAULT_CONFIG_V1.wakeWord, sensitivity: WAKE_SENSITIVITY_DEFAULT },
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
    micDeviceId: '',
    language: 'en',
    conversation: true,
    whisperMode: false
  },
  a11y: {
    announce: 'auto',
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
    shortcuts: { ...A11Y_DEFAULTS.shortcuts },
    coexist: { yieldToVoiceControl: true, wakeWithDragon: false },
    face: { ...FACE_DEFAULTS, bindings: { ...FACE_DEFAULTS.bindings }, thresholds: {} }
  },
  buddy: { enabled: false, color: 'accent', size: 'm', followCursor: true },
  agent: {
    confirm: 'risky',
    cancelWindowMs: 3000,
    allowSendWithoutReview: false,
    howtoLookup: 'auto',
    background: {
      max: 3,
      maxModelCalls: 30,
      maxCostUsd: 0.25,
      maxWallMin: 15,
      readFolders: [],
      quiet: false
    },
    subagents: { max: 4, model: 'fast', costCapUsd: 0.05 },
    proactive: { enabled: false, rules: [] }
  },
  privacy: { saveScreenshots: false, telemetry: false },
  audit: { retentionDays: 30, storeTypedText: false },
  teach: {
    activeSkill: null,
    hintLevel: 'auto',
    reviewReminders: true,
    idleHint: false,
    idleHintApps: [],
    idleHintSec: 20,
    idleHintVoice: false
  },
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
    backtrack: true,
    format: true,
    styles: DICTATION_STYLE_DEFAULTS,
    styleApps: {},
    commandMode: true,
    snippets: true,
    sounds: true,
    caretPill: true,
    duckMedia: false,
    spokenKeys: true,
    silenceSec: 2,
    mouseButton: 'off',
    hotkey: 'Ctrl+Shift+D',
    cleanup: 'light',
    autoDetect: true,
    terminal: 'type-no-enter',
    dictionary: [],
    history: true,
    showStats: false,
    appDictionary: {},
    spellAs: [],
    screenNames: false,
    codingMode: true
  },
  ui: { homeHotkey: 'Ctrl+Shift+H' },
  onboarding: { done: false },
  system: { startAtLogin: false, autoUpdate: true },
  helpers: HELPERS_DEFAULTS,
  web: WEB_DEFAULTS,
  usage: USAGE_DEFAULTS,
  debug: { perfOverlay: false }
}

const V1_KEYS = new Set(Object.keys(configV1Schema.shape))
const V2_KEYS = new Set(Object.keys(configV2Schema.shape))
/** Fields of the old window set (HUD, status bubble): dropped on load, never kept in `legacy`. */
const RETIRED_KEYS = new Set(['hudAutoCloseMs', 'statusBubble'])

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Maps a v1 (or version-less) config object onto the v2 layout. Unknown keys go to `legacy`. */
export function migrateV1toV2(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 2 }
  const legacy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    if (RETIRED_KEYS.has(key)) continue
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
    if (RETIRED_KEYS.has(key)) continue
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
    theme: s2.theme,
    themeCustom: s2.themeCustom,
    accent: s2.accent,
    models: s2.models.partial().strict(),
    hotkey: s2.hotkey,
    answerAutoCloseMs: s2.answerAutoCloseMs,
    wakeWord: s2.wakeWord.partial().strict(),
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
    audit: s2.audit.unwrap().partial().strict(),
    teach: s2.teach.partial().strict(),
    memory: s2.memory.partial().strict(),
    ai: s2.ai.partial().strict(),
    dictation: s2.dictation.partial().strict(),
    ui: s2.ui.partial().strict(),
    onboarding: s2.onboarding.partial().strict(),
    system: s2.system.partial().strict(),
    helpers: helpersSchema.partial().strict(),
    web: webSchema.partial().strict(),
    usage: z.object({ limits: usageSchema.shape.limits.partial().strict() }).partial().strict(),
    debug: s2.debug.unwrap().partial().strict()
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
