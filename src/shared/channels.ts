// IPC channel names and payload types (CONTRACTS C5). Zod-free so the sandboxed preload can
// import it; the matching validators live in ./ipc.ts and run in main.
import type { ConfigPatch } from './config'
import type { AssistantState, LessonCommand, ScreenScene } from './events'
import type { GuideStep, LocateItem, ModelResponse, Point, Rect, SavedGuide } from './types'

type Confidence = 'high' | 'medium' | 'low'

/** renderer → main, request/response (`ipcRenderer.invoke`). */
export interface InvokeChannels {
  'assistant:query': {
    args: [prompt: string, opts?: { lowDetail?: boolean }]
    result: ModelResponse | { error: string }
  }
  'assistant:execute': {
    args: [actions: unknown[]]
    result: { done?: boolean; cancelled?: boolean; reached_bottom?: boolean; error?: string }
  }
  'assistant:announce': {
    args: [summary: string, confidence?: Confidence | string]
    result: { delayMs: number }
  }
  'voice:transcribe': {
    args: [audio: ArrayBuffer, opts?: { dictation?: boolean }]
    result: string
  }
  /** Dictation hotkey transcript to clean up and type; "" ends the session with nothing typed. */
  'voice:dictate': { args: [text: string]; result: { ok: boolean; notice?: string } }
  'voice:speak': { args: [text: string]; result: { ok: boolean; error?: string } }
  'voice:stt-status': { args: []; result: SttStatus }
  'voice:stt-install': { args: []; result: { ok: boolean; error?: string } }
  /** Whether main wants the wake-word mic feed (renderer start-up sync). */
  'voice:wake-state': { args: []; result: { listen: boolean } }
  'settings:get': { args: []; result: Record<string, unknown> }
  'settings:patch': {
    args: [patch: ConfigPatch | Record<string, unknown>]
    result: Record<string, unknown>
  }
  'screen:hide': { args: []; result: void }
  'guides:list': { args: []; result: SavedGuide[] }
  'guides:save-last': { args: [name?: string]; result: SavedGuide | { error: string } }
  'guides:replay': { args: [id: string]; result: SavedGuide | { error: string } }
  'guides:delete': { args: [id: string]; result: { ok: boolean } }
  'wake:model-status': { args: []; result: WakeStatus }
  'wake:model-install': { args: []; result: { ok: boolean; error?: string } }
  'keys:status': { args: []; result: KeyStatus[] }
  'keys:set': { args: [req: { provider: KeyProvider; key: string }]; result: KeySetResult }
  'keys:clear': { args: [provider: KeyProvider]; result: { ok: boolean } }
  'keys:test': { args: [provider: KeyProvider]; result: { ok: boolean; error?: string } }
  /** First-run checks (keys, mic, agent, hotkey, OCR, wake model, elevation); cheap, no agent calls. */
  'firstrun:list': { args: []; result: FirstRunCheck[] }
  /** Runs one check for real (hotkey waits up to 20 s for a press). */
  'firstrun:run': { args: [id: FirstRunCheckId]; result: FirstRunCheck }
  'firstrun:fix': { args: [id: FirstRunCheckId]; result: { ok: boolean; error?: string } }
  'firstrun:complete': { args: []; result: { ok: boolean } }
  /** Zips logs, crash dumps, redacted config and versions to a file the user picks. */
  'diag:export': { args: []; result: { ok: boolean; path?: string; error?: string } }
  'diag:open-logs': { args: []; result: { ok: boolean } }
  'diag:info': { args: []; result: AppBuildInfo }
  'home:info': { args: []; result: HomeInfo }
  /** "What can I say": every local voice command, with what applies right now first. */
  'a11y:commands': { args: []; result: CommandSheetData }
  /** Dwell click-type palette: current pick, pause and drag/scroll state. */
  'a11y:dwell-state': { args: []; result: DwellPaletteState }
  'a11y:keyboard-state': { args: []; result: ScanKeyboardState }
  /** Global a11y shortcuts and whether each is bound, off, waiting or in conflict. */
  'a11y:shortcuts': { args: []; result: ShortcutStatus[] }
  /** Applies accessibility profiles (shared/profiles ids) on top of the config; returns it. */
  'a11y:apply-profile': { args: [ids: string[]]; result: Record<string, unknown> }
  'onboarding:info': { args: []; result: OnboardingInfo }
  'memory:get': { args: []; result: MemoryOverview }
  'memory:fact': { args: [op: MemoryFactOp]; result: MemoryResult }
  'memory:review': { args: [req: { id: string; accept: boolean }]; result: MemoryResult }
  'memory:episodes': { args: [query?: string]; result: MemoryEpisodeView[] }
  'memory:episode-delete': { args: [id: string]; result: MemoryResult }
  'memory:export': { args: []; result: MemoryResult & { path?: string } }
  /** Deletes the whole memory folder; `confirm` must be the word DELETE typed by the user. */
  'memory:delete-all': { args: [confirm: string]; result: MemoryResult }
  /** Model spend: today, this session, the last 30 days and a rough per-day estimate. */
  'usage:get': { args: []; result: UsageOverview }
  /** Which OS agent is running (Settings shows it read-only). */
  'agent:info': { args: []; result: AgentImplInfo }
  /** Lessons (07 T22): every pack and user lesson, or one app's when `appId` is given. */
  'teach:list': { args: [appId?: string]; result: LessonListItem[] }
  /** Starts a lesson; the lesson left part-way resumes on its step. */
  'teach:start': { args: [id: string]; result: { ok: boolean; error?: string } }
  /** next / back / pause / stop … for the running lesson (buttons, switch). */
  'teach:command': { args: [command: LessonCommand]; result: { ok: boolean } }
  /** The lesson to continue and recent completions (Home "Continue learning"). */
  'teach:progress': { args: []; result: LessonProgressView }
  /** Deletes one of the user's own lessons. */
  'teach:delete': { args: [id: string]; result: { ok: boolean } }
  /** Saves the last "show me how" lesson to the user's lessons. */
  'teach:save-last': {
    args: [name?: string]
    result: { id: string; title: string } | { error: string }
  }
}

/** renderer → main, fire and forget (`ipcRenderer.send`). */
export interface SendChannels {
  'assistant:show': []
  'assistant:close': []
  'assistant:cancel': []
  'assistant:open-link': [url: string]
  'answer:show': [text: string]
  'answer:hide': []
  'answer:resize': [height: number]
  'settings:open': []
  'settings:window-close': []
  'settings:window-minimize': []
  'settings:window-maximize': []
  /** A hands-free recording ended on its own (silence, no speech, mic error). */
  'voice:ended': []
  /** 100 ms of 16 kHz mono Int16 mic audio for the wake-word spotter. */
  'voice:wake-pcm': [pcm: ArrayBuffer]
  /** The user talked over a spoken answer (playback already stopped): start listening. */
  'voice:barge-in': []
  'assistant:command': [cmd: AssistantCommand]
  /** Card size in CSS px, for dwell suppression over the bar. */
  'assistant:resize': [size: { w: number; h: number }]
  /** Pointer is over the card: stop forwarding clicks through the window. */
  'assistant:interactive': [on: boolean]
  'screen:user-drawing': [drawing: { points: Point[]; rect: Rect }]
  'screen:capture-end': []
  /** Opens the panel window at a route: settings, settings/<section>, onboarding, home. */
  'panel:open': [route: string]
  /** Closes the panel window (or flyout) that sent it. */
  'panel:close': []
  'home:run': [text: string]
  /** Onboarding practice board: the button the user clicked, for the mini lesson's check. */
  'teach:practice': [label: string]
  'memory:open-folder': []
  /** Command sheet: close its window. */
  'a11y:sheet-close': []
  /** Dwell palette button (dwelled on or clicked); `keyboard` shows or hides the scan keyboard. */
  'a11y:dwell-pick': [pick: DwellPaletteButton | 'keyboard']
  /** Scan keyboard key clicked or dwelled on (ScanKeyboardKey id). */
  'a11y:keyboard-key': [id: string]
}

/**
 * One a11y shortcut: bound, off (""), inactive (only held while dwell / a lesson runs),
 * conflict (same key as another Lumen shortcut, `with` says which) or taken by another app.
 */
export interface ShortcutStatus {
  action: string
  label: string
  accelerator: string
  state: 'bound' | 'off' | 'inactive' | 'conflict' | 'taken'
  with?: string
}

/** One scan keyboard key; `on` = a latched modifier (Shift, Caps). */
export interface ScanKeyboardKey {
  id: string
  label: string
  /** Spoken name when the label is a symbol. */
  name?: string
  /** Width in key units (default 1). */
  wide?: number
  on?: boolean
}

export interface ScanKeyboardState {
  /** Row 0 holds the word suggestions (may be empty). */
  rows: ScanKeyboardKey[][]
  /** Switch scanning highlight: a row, then a key in it. */
  highlight: { row: number | null; key: number | null }
  shift: boolean
  caps: boolean
}

export type DwellPaletteButton = 'left' | 'right' | 'double' | 'drag' | 'scroll' | 'pause'

export interface DwellPaletteState {
  enabled: boolean
  /** Click type the next dwell does. */
  next: Exclude<DwellPaletteButton, 'pause'>
  /** The pick stays after a click instead of going back to the default. */
  sticky: boolean
  paused: boolean
  /** A drag start is set and waits for the drop dwell. */
  dragging: boolean
  /** The scroll arrows are on screen. */
  scrolling: boolean
}

export interface CommandSheetRow {
  category: string
  say: string
  does: string
  /** When it applies ("while numbers are shown"); absent = any time. */
  when?: string
  /** It applies right now (always true for rows without `when`). */
  now: boolean
}

export interface CommandSheetData {
  rows: CommandSheetRow[]
  /** Shortcut that opens the sheet; "" = none. */
  hotkey: string
}

/** Dwell ring on the screen layer, in that display's DIP. */
export interface DwellRingData {
  x: number
  y: number
  progress: number
  active: boolean
  /** left, right, double, drag, drop, scroll, pause. */
  clickType?: string
  paused?: boolean
  /** Ring diameter, logical px. */
  size?: number
  /** Snapped element the click will hit. */
  target?: Rect
  /** A risky target waits for a second dwell. */
  warn?: boolean
}

export interface StatusMessage {
  kind: string
  text: string
  step?: { index: number; total: number }
}

/** Which speech-to-text engine answers and how the offline model download is going. */
export interface SttStatus {
  pref: string
  engine: 'local' | 'cloud' | null
  localSupported: boolean
  localInstalled: boolean
  installing: boolean
  percent?: number
  modelSizeMb: number
}

export type KeyProvider = 'anthropic' | 'openai'

/** Never carries the key itself, only where it came from and its last 4 characters. */
export interface KeyStatus {
  provider: KeyProvider
  set: boolean
  source?: 'env' | 'vault'
  last4?: string
}

export interface KeySetResult {
  ok: boolean
  /** False when Windows encryption is unavailable and the key lives in memory only. */
  persisted: boolean
  error?: string
}

export type AssistantCommand = {
  type: 'repeat' | 'pin' | 'close' | 'copy' | 'cancel' | 'confirm' | 'deny' | 'unmute'
  turnId?: string
}

/** What the assistant bar renders: CONTRACTS C6 state plus display settings from main. */
export interface AssistantView extends AssistantState {
  /** False when the bar should play its exit and main is about to hide the window. */
  visible: boolean
  /** Auto-close for answers and errors; 0 = never. */
  autoCloseMs: number
  costUsd?: number
}

export type MemoryLayerName = 'profile' | 'app' | 'working'

export interface MemoryFactView {
  section: string
  text: string
  /** YYYY-MM-DD */
  date?: string
  source: 'said' | 'inferred'
}

export interface MemoryProposalView {
  id: string
  layer: MemoryLayerName
  appId?: string
  fact: string
  confidence: number
  createdAt: string
}

/** One local day of model usage (~/.ai-overlay/usage.json). */
export interface UsageDay {
  /** Local date, YYYY-MM-DD. */
  date: string
  usd: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface UsageOverview {
  today: UsageDay
  /** Since the app started. */
  sessionUsd: number
  /** Oldest first, only days with calls, at most 30. */
  days: UsageDay[]
  /** Average over the days with calls in the last 7 (today included); 0 without data. */
  estimatePerDay: number
  /** estimatePerDay x 30. */
  estimatePerMonth: number
  /** Some calls this session used a model without a known price (counted at the Sonnet rate). */
  estimated: boolean
}

/** Everything the Settings → Memory page shows, in one call. */
export interface MemoryOverview {
  enabled: boolean
  autoLearn: 'auto' | 'ask' | 'off'
  privateMode: boolean
  retentionDays: number
  /** Folder the markdown files live in. */
  dir: string
  profile: MemoryFactView[]
  working: MemoryFactView[]
  apps: { id: string; facts: MemoryFactView[] }[]
  /** Facts waiting for the user's yes/no (the review chip). */
  pending: MemoryProposalView[]
  episodeCount: number
}

export interface MemoryEpisodeView {
  id: string
  /** ISO timestamp of the session end. */
  date: string
  title: string
  summary: string
  apps: string[]
  outcome: 'done' | 'partial' | 'failed' | 'info'
  openThreads: string[]
  refs: { kind: 'url' | 'file' | 'lesson' | 'skill'; value: string }[]
}

/** Profile editor operations; `app` is required for the app layer. */
export type MemoryFactOp =
  | { op: 'add'; layer: MemoryLayerName; app?: string; text: string; section?: string }
  | {
      op: 'update'
      layer: MemoryLayerName
      app?: string
      old: string
      text: string
      section?: string
    }
  | { op: 'remove'; layer: MemoryLayerName; app?: string; text: string }

export interface MemoryResult {
  ok: boolean
  error?: string
}

export interface OnboardingInfo {
  /** A screen reader is running, so onboarding does not read itself aloud. */
  screenReader: boolean
}

export type FirstRunCheckId =
  | 'keys'
  | 'microphone'
  | 'agent'
  | 'hotkey'
  | 'ocr'
  | 'wake-model'
  | 'elevation'

export interface FirstRunCheck {
  id: FirstRunCheckId
  /** `pending`: not run yet (needs firstrun:run). */
  status: 'ok' | 'warn' | 'fail' | 'pending'
  message: string
  /** Button label when firstrun:fix can help (opens a Settings page, downloads a model). */
  fixAction?: string
}

/** Build facts for About and diagnostics. */
export interface AppBuildInfo {
  version: string
  electron: string
  packaged: boolean
  /** Running from the portable exe: no updates, no start at login. */
  portable: boolean
  logsDir: string
}

/** The running OS agent: the Rust sidecar or the Python fallback. */
export interface AgentImplInfo {
  impl: 'native' | 'python' | null
  /** Agent version; null for the Python agent on protocol v1. */
  version: string | null
  protocol: 1 | 2 | null
  /** Why `auto` dropped the native agent this session, or null. */
  fallback: string | null
}

/** One lesson in the picker (07 T22). */
export interface LessonListItem {
  id: string
  title: string
  summary?: string
  appId: string
  appName: string
  level: 'beginner' | 'intermediate' | 'advanced'
  minutes: number
  steps: number
  /** pack = shipped with Lumen; user = the user's own (saved or migrated guide). */
  source: 'pack' | 'user'
  /** Times completed. */
  completed: number
}

export interface LessonProgressView {
  /** A lesson that is running or was left part-way in the last 7 days. */
  active: {
    lessonId: string
    title: string
    appName: string
    /** 1-based. */
    step: number
    total: number
    running: boolean
  } | null
  /** Completed lessons, newest first (max 5). */
  recent: { lessonId: string; title: string; appName: string; completedAt: number }[]
}

export interface HomeInfo {
  hotkey: string
  agentReady: boolean
  wakeWord: boolean
  dwell: boolean
  buddy: boolean
  recent: string[]
}

/** Wake word / voice-cancel engine state for Settings. */
export interface WakeStatus {
  /** The model for this PC's engine (spotter, or Vosk without the native engine) is installed. */
  installed: boolean
  path: string
  /** Running engine: keyword spotter, Vosk fallback, or nothing listening. */
  engine: 'kws' | 'vosk' | 'off'
  /** Download size of that model, MB. */
  sizeMb: number
  /** Wake/stop phrases the spotter can't spell (they are ignored). */
  unusable: string[]
}

export interface WakeModelProgress {
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  percent?: number
  bytes?: number
  total?: number
  message?: string
}

/**
 * How a recording ends: `hold` on voice:stop (key release), `hands-free` on silence (tap,
 * wake word), `dictation` on voice:stop or, after voice:hands-free, on silence.
 */
export type VoiceStartMode = 'hold' | 'hands-free' | 'dictation'

/** Spoken reply playback in the voice renderer: Windows voice text, or cloud audio (base64). */
export type TtsMessage =
  | { op: 'say'; turnId: string; seq: number; text: string; voice: string; rate: number }
  | { op: 'audio'; turnId: string; seq: number; mime: string; data: string }
  | { op: 'stop' }

/** main → renderer events (`webContents.send`). */
export interface EventChannels {
  'screen:highlights': [steps: GuideStep[]]
  'screen:clear': []
  'screen:pointer': [pointer: Point & { text: string }]
  'screen:locate': [items: LocateItem[]]
  'screen:dwell': [data: DwellRingData]
  'screen:render': [scene: ScreenScene]
  /** Cursor in this display's DIP, or null when it is on another display. */
  'screen:cursor': [point: Point | null]
  'screen:set-capture': [on: boolean]
  'assistant:state': [view: AssistantView]
  'home:shown': []
  /** Home flyout: focus the "Ask" field (tray menu "Ask…"). */
  'home:ask': []
  /** Panel window: switch to this route without reloading. */
  'panel:route': [route: string]
  'answer:text': [text: string]
  'assistant:cancel-request': []
  'assistant:run-query': [text: string]
  'settings:changed': [config: Record<string, unknown>]
  'wake:model-progress': [progress: WakeModelProgress]
  /** The wake engine changed (applied settings, model installed, fallback). */
  'wake:status': [status: WakeStatus]
  'voice:stt-model-progress': [progress: WakeModelProgress]
  'status:set': [message: StatusMessage]
  'status:hide': []
  'voice:start': [opts: { mode: VoiceStartMode }]
  'voice:stop': []
  /** The open dictation recording becomes hands-free (ends on silence). */
  'voice:hands-free': []
  /** Memory changed (voice command, session end, settings); `pending` drives the review chip. */
  'memory:changed': [summary: { pending: number }]
  /** Command sheet window shown again: re-read the commands for the current context. */
  'a11y:sheet-refresh': []
  'a11y:dwell-state': [state: DwellPaletteState]
  'a11y:keyboard-state': [state: ScanKeyboardState]
  /** Assistant bar got keyboard focus from the shortcut: focus its first control. */
  'assistant:focus': []
  'voice:tts': [msg: TtsMessage]
  /** Start or stop streaming mic audio to the wake-word spotter. */
  'voice:wake-listen': [on: boolean]
}

export type InvokeChannel = keyof InvokeChannels
export type SendChannel = keyof SendChannels
export type EventChannel = keyof EventChannels

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'assistant:query',
  'assistant:execute',
  'assistant:announce',
  'voice:transcribe',
  'voice:dictate',
  'voice:speak',
  'voice:stt-status',
  'voice:stt-install',
  'voice:wake-state',
  'settings:get',
  'settings:patch',
  'screen:hide',
  'guides:list',
  'guides:save-last',
  'guides:replay',
  'guides:delete',
  'wake:model-status',
  'wake:model-install',
  'keys:status',
  'keys:set',
  'keys:clear',
  'keys:test',
  'firstrun:list',
  'firstrun:run',
  'firstrun:fix',
  'firstrun:complete',
  'diag:export',
  'diag:open-logs',
  'diag:info',
  'home:info',
  'a11y:commands',
  'a11y:dwell-state',
  'a11y:keyboard-state',
  'a11y:shortcuts',
  'a11y:apply-profile',
  'onboarding:info',
  'memory:get',
  'memory:fact',
  'memory:review',
  'memory:episodes',
  'memory:episode-delete',
  'memory:export',
  'memory:delete-all',
  'usage:get',
  'agent:info',
  'teach:list',
  'teach:start',
  'teach:command',
  'teach:progress',
  'teach:delete',
  'teach:save-last'
]

export const SEND_CHANNELS: readonly SendChannel[] = [
  'assistant:show',
  'assistant:close',
  'assistant:cancel',
  'assistant:open-link',
  'answer:show',
  'answer:hide',
  'answer:resize',
  'settings:open',
  'settings:window-close',
  'settings:window-minimize',
  'settings:window-maximize',
  'voice:ended',
  'voice:wake-pcm',
  'voice:barge-in',
  'assistant:command',
  'assistant:resize',
  'assistant:interactive',
  'screen:user-drawing',
  'screen:capture-end',
  'panel:open',
  'panel:close',
  'home:run',
  'teach:practice',
  'memory:open-folder',
  'a11y:sheet-close',
  'a11y:dwell-pick',
  'a11y:keyboard-key'
]

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'screen:highlights',
  'screen:clear',
  'screen:pointer',
  'screen:locate',
  'screen:dwell',
  'screen:render',
  'screen:cursor',
  'screen:set-capture',
  'assistant:state',
  'home:shown',
  'home:ask',
  'panel:route',
  'answer:text',
  'assistant:cancel-request',
  'assistant:run-query',
  'settings:changed',
  'wake:model-progress',
  'wake:status',
  'voice:stt-model-progress',
  'status:set',
  'status:hide',
  'voice:start',
  'voice:stop',
  'voice:hands-free',
  'voice:tts',
  'voice:wake-listen',
  'memory:changed',
  'a11y:sheet-refresh',
  'a11y:dwell-state',
  'a11y:keyboard-state',
  'assistant:focus'
]

/** Typed surface exposed to renderers as `window.lumen`. */
export interface LumenApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeChannels[C]['args']
  ): Promise<InvokeChannels[C]['result']>
  send<C extends SendChannel>(channel: C, ...args: SendChannels[C]): void
  on<C extends EventChannel>(channel: C, cb: (...args: EventChannels[C]) => void): () => void
}
