// IPC channel names and payload types (CONTRACTS C5). Zod-free so the sandboxed preload can
// import it; the matching validators live in ./ipc.ts and run in main.
import type {
  ClaudeCliStatus,
  ClaudeCodeSettings,
  ClaudeHooksPreview,
  ClaudeProject,
  ClaudeProjectEntry,
  ClaudeSessionView,
  ClaudeSettingsPatch
} from './claude-code'
import type { ConfigPatch } from './config'
import type {
  ConnectorInput,
  ConnectorResult,
  ConnectorTestResult,
  ConnectorToolInfo,
  ConnectorView
} from './connectors'
import type { AssistantState, LessonCommand, ScreenScene } from './events'
import type { DictationHistoryView, DictationStatsView, Note } from './dictation-history'
import type { BackgroundTask } from './types'
import type { RoutineUpdate, RoutineView } from './routines'
import type {
  GuideStep,
  LocateItem,
  ModelResponse,
  Point,
  Rect,
  SavedGuide,
  SkillPermissions,
  SkillRunRecord,
  SkillSummary
} from './types'

type Confidence = 'high' | 'medium' | 'low'

export interface ClaudeResult {
  ok: boolean
  error?: string
}

export interface ClaudeStatus {
  cli: ClaudeCliStatus
  settings: ClaudeCodeSettings
  hookPort: number
  sessions: ClaudeSessionView[]
  pending: {
    id: string
    sessionKey: string
    projectName: string
    tool: string
    what: string
    reason: string
    hard: boolean
  }[]
}

/** Settings, Smart helpers: what the shortcut coach and fatigue proposals remember. */
export interface CoachStatus {
  /** Shortcuts the user now uses (tips stopped). */
  learned: { app: string; action: string; combo: string }[]
  /** Menu commands being counted. */
  tracking: number
  /** Fatigue proposals answered (yes / no), remembered. */
  answered: { id: string; answer: 'yes' | 'no' }[]
}

/** Settings, Smart helpers: apps with community labels (11 T13). */
export interface LabelAppInfo {
  app: string
  appName: string
  count: number
  /** Made or checked by a person. */
  human: number
}

export interface LabelEntryView {
  key: string
  role: string
  label: string
  description?: string
  source: 'ai' | 'human'
  confidence: number
  /** mine = made on this PC; shared = came in a `.lumen` file. */
  origin?: 'mine' | 'shared'
}

/** Helper handoff (11 T24): lessons (+ their apps' labels) shared as one `.lumen` file. */
export interface HandoffExport {
  lessonIds: string[]
  title: string
  from?: string
  note?: string
  includeLabels: boolean
}

export interface HandoffInfo {
  id: string
  title: string
  from?: string
  note?: string
  lessons: number
  installedAt: string
}

export interface HandoffInstallResult {
  ok: boolean
  installed?: {
    id: string
    title: string
    from?: string
    lessons: number
    labels: number
    updated: boolean
  }[]
  error?: string
  problems?: string[]
}

/** Practice challenges (11 T22): the running one, the streak and recent results. */
export interface ChallengeView {
  active: {
    id: string
    app: string
    appName: string
    title: string
    goal: string
    setup: string
    level: 'beginner' | 'intermediate' | 'advanced'
    minutes: number
    rubric: string[]
    secondsLeft: number
  } | null
  streak: number
  best: number
  passed: number
  recent: {
    id: string
    app: string
    title: string
    level: 'beginner' | 'intermediate' | 'advanced'
    finishedAt: number
    passed: boolean
    met: number
    total: number
    feedback: string
  }[]
}

/** Tutorial → lesson (11 T12): what to read; `file` opens a subtitle file picker. */
export type TutorialImportRequest =
  | { kind: 'text'; text: string; appId?: string }
  | { kind: 'url'; url: string; appId?: string }
  | { kind: 'file'; appId?: string }

export interface TutorialImportResult {
  ok: boolean
  title?: string
  steps?: number
  appName?: string
  /** Spoken version-drift line, "" when the tutorial names no version. */
  drift?: string
  error?: string
}

/** One camera frame's gesture scores from the face renderer (11 T25); no image data. */
export interface FaceFrame {
  /** A face was found; the scores are 0 otherwise. */
  face: boolean
  /** Blendshapes, 0..1. */
  mouthOpen: number
  browRaise: number
  smile: number
  /** Head roll and yaw in degrees. */
  roll: number
  yaw: number
}

export type FaceAssets =
  | { ok: true; wasm: Uint8Array; model: Uint8Array; cameraId: string }
  | { ok: false; error: string }

export interface FaceState {
  /** Model + wasm downloaded and verified. */
  installed: boolean
  /** Download progress, 0..100, while installing. */
  installing?: number
  status: 'off' | 'starting' | 'running' | 'error'
  error?: string
  /** Latest scores (null when no frame came in the last second). */
  frame: FaceFrame | null
  /** Each gesture's latest strength: 0 at rest, 1 at its threshold. */
  levels: Record<string, number>
  /** Last gesture that acted. */
  last?: { gesture: string; action: string; at: number }
  /** Calibration is sampling (gestures do not act meanwhile). */
  calibrating: boolean
}

export type FaceCalibrateStep = { step: 'rest' } | { step: 'gesture'; gesture: string }

export interface FaceCalibrateResult {
  ok: boolean
  message: string
  /** Frames with a face in the sample. */
  samples: number
}

/** renderer → main, request/response (`ipcRenderer.invoke`). */
export interface InvokeChannels {
  /** Face-gesture input (11 T25): face renderer assets, Settings state / install / calibration. */
  'face:assets': { args: []; result: FaceAssets }
  'face:state': { args: []; result: FaceState }
  'face:install': { args: []; result: { ok: boolean; error?: string } }
  'face:calibrate': { args: [step: FaceCalibrateStep]; result: FaceCalibrateResult }
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
  /** Files dropped on the bar in this conversation (08 T21). */
  'assistant:files': { args: []; result: DroppedFileView[] }
  'assistant:file-remove': { args: [fileId: string]; result: FileDropResult }
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
  /** Dictation history, stats and notes (04 T44-T46), Home flyout. */
  'dictation:history': { args: []; result: DictationHistoryView }
  'dictation:history-delete': { args: [id: string]; result: { ok: boolean } }
  'dictation:history-clear': { args: []; result: { ok: boolean } }
  'dictation:history-copy': { args: [id: string]; result: { ok: boolean } }
  /** Types the entry again into the field focused once the flyout has closed. */
  'dictation:history-insert': { args: [id: string]; result: { ok: boolean; notice?: string } }
  'dictation:stats': { args: []; result: DictationStatsView }
  'dictation:stats-reset': { args: []; result: { ok: boolean } }
  'notes:list': { args: []; result: Note[] }
  'notes:add': { args: [text: string]; result: { ok: boolean; note?: Note } }
  'notes:update': { args: [id: string, text: string]; result: { ok: boolean } }
  'notes:delete': { args: [id: string]; result: { ok: boolean } }
  'notes:copy': { args: [id: string]; result: { ok: boolean } }
  'settings:get': { args: []; result: Record<string, unknown> }
  'settings:patch': {
    args: [patch: ConfigPatch | Record<string, unknown>]
    result: Record<string, unknown>
  }
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
  /** Update state for About (no network). */
  'update:status': { args: []; result: UpdateStatus }
  /** Checks now; the installed build then downloads in the background. */
  'update:check': { args: []; result: UpdateStatus }
  /** Restarts into a downloaded update (installed build, user click only). */
  'update:install': { args: []; result: { ok: boolean } }
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
  /** Claude Code copilot (08 T33–T40): CLI, settings, live sessions, waiting permissions. */
  'claude:status': { args: []; result: ClaudeStatus }
  'claude:settings-set': { args: [patch: ClaudeSettingsPatch]; result: ClaudeCodeSettings }
  'claude:projects': { args: []; result: ClaudeProject[] }
  'claude:project-set': { args: [entry: ClaudeProjectEntry]; result: ClaudeResult }
  'claude:project-remove': { args: [path: string]; result: ClaudeResult }
  'claude:pick-folder': { args: []; result: string | null }
  'claude:open': {
    args: [req: { project: string; prompt?: string; resume?: boolean }]
    result: ClaudeResult & { session?: ClaudeSessionView }
  }
  'claude:send': { args: [req: { id: string; text: string }]; result: ClaudeResult }
  'claude:interrupt': { args: [id: string]; result: ClaudeResult }
  'claude:close': { args: [id: string]; result: ClaudeResult }
  'claude:permission-answer': {
    args: [req: { id: string; answer: 'once' | 'always' | 'deny' }]
    result: ClaudeResult
  }
  /** The exact ~/.claude/settings.json change for the opt-in global hooks (T38). */
  'claude:hooks-preview': {
    args: [install: boolean]
    result: ClaudeHooksPreview | { error: string }
  }
  /** Writes it only if the file still has the previewed hash. */
  'claude:hooks-apply': { args: [install: boolean, hash: string]; result: ClaudeResult }
  /** Stored "always" grants for medium-risk actions (08 T03). */
  'agent:grants-list': { args: []; result: AgentGrant[] }
  'agent:grants-revoke': { args: [scope: string]; result: { ok: boolean } }
  /** Background tasks (CONTRACTS C11), newest first; listing marks finished ones seen. */
  'tasks:list': { args: []; result: BackgroundTask[] }
  'tasks:cancel': { args: [id: string]; result: { ok: boolean } }
  /** Shows the result on the assistant bar (or the waiting question). */
  'tasks:open': { args: [id: string]; result: { ok: boolean } }
  /** Answers a task's queued question. */
  'tasks:answer': { args: [id: string, answer: string]; result: { ok: boolean } }
  /** Starts an interrupted, failed or cancelled task again as a new task. */
  'tasks:run-again': { args: [id: string]; result: { ok: boolean; id?: string } }
  /** Routines (08 T22): Settings list, on/off, rename, mouse pre-approval, remove, run now. */
  'routines:list': { args: []; result: RoutineView[] }
  'routines:update': { args: [update: RoutineUpdate]; result: { ok: boolean } }
  'routines:remove': { args: [id: string]; result: { ok: boolean } }
  'routines:run-now': { args: [id: string]; result: { ok: boolean } }
  /** One day of the action audit log (YYYY-MM-DD), optionally one task's lines (08 T04). */
  'audit:list': { args: [query: { date: string; taskId?: string }]; result: AuditLine[] }
  /** Learning journal (11 T23): days with a note, newest first; one day's markdown. */
  'helpers:journal-days': { args: []; result: string[] }
  'helpers:journal-read': { args: [date: string]; result: { ok: boolean; markdown?: string } }
  /** Deletes every journal note. */
  'helpers:journal-clear': { args: []; result: { ok: boolean } }
  /** Shortcut coach (11 T17) and fatigue answers (11 T18) kept on this PC. */
  'helpers:coach-status': { args: []; result: CoachStatus }
  'helpers:coach-reset': { args: []; result: { ok: boolean } }
  /** Community labels (11 T13): apps, one app's labels, fix / delete, save as labels.json. */
  'labels:apps': { args: []; result: LabelAppInfo[] }
  'labels:entries': { args: [app: string]; result: LabelEntryView[] }
  'labels:edit': {
    args: [edit: { app: string; key: string; label: string | null }]
    result: { ok: boolean }
  }
  'labels:remove-app': { args: [app: string]; result: { ok: boolean } }
  'labels:save-json': {
    args: [app: string]
    result: { ok: boolean; path?: string; error?: string }
  }
  /** The app's labels as a `.lumen` file (a labels-only helper handoff, 11 T24). */
  'labels:export-lumen': {
    args: [app: string]
    result: { ok: boolean; path?: string; error?: string }
  }
  /** Lessons (07 T22): every pack and user lesson, or one app's when `appId` is given. */
  'teach:list': { args: [appId?: string]; result: LessonListItem[] }
  /** Starts a lesson; the lesson left part-way resumes on its step. */
  'teach:start': { args: [id: string]; result: { ok: boolean; error?: string } }
  /** next / back / pause / stop … for the running lesson (buttons, switch). */
  'teach:command': { args: [command: LessonCommand]; result: { ok: boolean } }
  /** The lesson to continue and recent completions (Home "Continue learning"). */
  'teach:progress': { args: []; result: LessonProgressView }
  /** Starts the short "prove it" review of a completed lesson (07 T29). */
  'teach:review': { args: [id: string]; result: { ok: boolean; error?: string } }
  /** Deletes one of the user's own lessons. */
  'teach:delete': { args: [id: string]; result: { ok: boolean } }
  /** Saves the last "show me how" lesson to the user's lessons. */
  'teach:save-last': {
    args: [name?: string]
    result: { id: string; title: string } | { error: string }
  }
  /** Record my steps (07 T31): start / stop / cancel watching the user's clicks and shortcuts. */
  'teach:record': {
    args: [action: 'start' | 'stop' | 'cancel']
    result: { ok: boolean; error?: string }
  }
  /** Whether a recording runs and the draft lesson waiting for review. */
  'teach:record-status': { args: []; result: RecordingStatus }
  /** Saves the reviewed draft (edited say lines, dropped steps) as a user lesson. */
  'teach:draft-save': {
    args: [edit: LessonDraftEdit]
    result: { id: string; title: string } | { error: string }
  }
  /** Plays the draft once to try it, without saving it. */
  'teach:draft-play': { args: []; result: { ok: boolean } }
  'teach:draft-discard': { args: []; result: { ok: boolean } }
  /** Community packs (07 T32): installed `.lumen` packs, install from a file or GitHub link. */
  'teach:pack-list': { args: []; result: CommunityPackInfo[] }
  'teach:pack-install-file': { args: []; result: PackInstallResult }
  'teach:pack-install-url': { args: [url: string]; result: PackInstallResult }
  'teach:pack-remove': { args: [id: string]; result: { ok: boolean } }
  /** Saves any pack as a `.lumen` file (save dialog). */
  'teach:pack-export': {
    args: [id: string]
    result: { ok: boolean; path?: string; error?: string }
  }
  /** Helper handoff (11 T24): share some of my lessons, open a helper's file, list, remove. */
  'teach:handoff-export': {
    args: [req: HandoffExport]
    result: { ok: boolean; path?: string; error?: string }
  }
  'teach:handoff-install': { args: []; result: HandoffInstallResult }
  'teach:handoff-list': { args: []; result: HandoffInfo[] }
  'teach:handoff-remove': { args: [id: string]; result: { ok: boolean } }
  /** Practice challenges (11 T22). Start in an app by pack id, or the app in front. */
  'teach:challenge-status': { args: []; result: ChallengeView }
  'teach:challenge-start': {
    args: [
      opts: { app?: string; level?: 'beginner' | 'intermediate' | 'advanced' | 'harder' | 'easier' }
    ]
    result: { ok: boolean; error?: string }
  }
  'teach:challenge-check': { args: []; result: { ok: boolean; text: string } }
  'teach:challenge-stop': { args: []; result: { ok: boolean } }
  /** Tutorial → lesson draft (11 T12), reviewed like a recording. */
  'teach:import-tutorial': { args: [req: TutorialImportRequest]; result: TutorialImportResult }
  /** Skills (11 T05/T06): Settings → Skills. */
  'skills:list': { args: []; result: SkillSummary[] }
  /** The full SKILL.md and the skill's file list, for View / Edit. */
  'skills:get': { args: [name: string]; result: SkillDetail | { ok: false; error: string } }
  'skills:set-enabled': { args: [name: string, enabled: boolean]; result: { ok: boolean } }
  /** Trust a community skill (its actions stop asking every time once the runner lands). */
  'skills:set-trusted': { args: [name: string, trusted: boolean]; result: { ok: boolean } }
  /** Saves an edited SKILL.md; a builtin skill is copied to the user folder first. */
  'skills:save': { args: [name: string, text: string]; result: SkillActionResult }
  'skills:create': { args: [name: string, description: string]; result: SkillActionResult }
  'skills:delete': { args: [name: string]; result: SkillActionResult }
  /** Install step 1: pick a `.lumen` file / fetch a GitHub link and show what it asks for. */
  'skills:preview-file': { args: []; result: SkillInstallPreview }
  'skills:preview-url': { args: [url: string]; result: SkillInstallPreview }
  /** Install step 2: the user accepted the permissions screen. */
  'skills:install': { args: [token: string]; result: PackInstallResult }
  'skills:install-cancel': { args: [token: string]; result: { ok: boolean } }
  /** Saves a skill as a `.lumen` file (save dialog). */
  'skills:export': { args: [name: string]; result: { ok: boolean; path?: string; error?: string } }
  /** A skill's last runs, newest first (11 T04). */
  'skills:runs': { args: [name: string]; result: SkillRunRecord[] }
  /** App bridges (07 T23–T26): live status of each, for Settings → App helpers. */
  'bridges:status': { args: []; result: BridgeStatus[] }
  'bridges:test': { args: [id: BridgeId]; result: BridgeStatus }
  /** Writes the Blender add-on zip and shows it in Explorer. */
  'bridges:blender-addon': { args: []; result: { ok: boolean; path?: string; error?: string } }
  /** OBS WebSocket password / port; stored encrypted, never shown again. */
  'bridges:obs-set': {
    args: [req: { password?: string; port?: number }]
    result: { ok: boolean; persisted: boolean }
  }
  'bridges:obs-clear': { args: []; result: { ok: boolean } }
  /** Connectors (08 T19): MCP servers. Secrets are write-only (only `hasBearer` comes back). */
  'connectors:list': { args: []; result: ConnectorView[] }
  'connectors:add': { args: [req: ConnectorInput]; result: ConnectorResult }
  'connectors:update': { args: [req: ConnectorInput]; result: ConnectorResult }
  'connectors:remove': { args: [id: string]; result: ConnectorResult }
  /** Connects now and reports the tool count or the error. */
  'connectors:test': { args: [id: string]; result: ConnectorTestResult }
  'connectors:tools': { args: [id: string]; result: ConnectorToolInfo[] | { error: string } }
}

/** renderer → main, fire and forget (`ipcRenderer.send`). */
export interface SendChannels {
  /** Face renderer: one frame's gesture scores (about 15 a second) and its state. */
  'face:frame': [frame: FaceFrame]
  'face:status': [status: { state: 'running' | 'error'; error?: string }]
  'assistant:show': []
  'assistant:close': []
  'assistant:cancel': []
  'assistant:open-link': [url: string]
  'answer:show': [text: string]
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
  /** Spoken reply started (true) or finished (false) in the voice renderer. */
  'voice:speaking': [speaking: boolean]
  'assistant:command': [cmd: AssistantCommand]
  /** A voice error in the renderer (microphone, transcription): shown in the bar's error row. */
  'assistant:error': [message: string]
  /** The corrected caption text: replaces the last utterance and runs it. */
  'assistant:correct': [text: string]
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
  /** Settings "Try it": a sample announcement through the user's announce settings. */
  'a11y:try': [what: 'announce']
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

export type BridgeId = 'blender' | 'obs'

export interface BridgeStatus {
  id: BridgeId
  name: string
  /** absent: app closed or bridge off; needs-setup: a password is needed; error: rejected. */
  state: 'connected' | 'absent' | 'needs-setup' | 'error'
  detail?: string
  /** Add-on version (Blender) or app version (OBS). */
  version?: string
  port?: number
  /** OBS: a password is saved. */
  hasPassword?: boolean
}

export type AssistantCommand = {
  type:
    | 'repeat'
    | 'pin'
    | 'close'
    | 'copy'
    | 'cancel'
    | 'confirm'
    | 'deny'
    | 'unmute'
    /** Open / close the caption for a correction. */
    | 'edit'
    | 'edit-cancel'
    /** Agent mode: retry a failed step / skip the countdown / answer an ask_user choice. */
    | 'retry'
    | 'go'
    | 'answer'
    /** Opens the "What can I say" sheet (simple mode's Help button). */
    | 'help'
    /** Escape in focused mode: give focus back, and close unless the answer is pinned. */
    | 'leave'
  turnId?: string
  /** retry: the step number (from 1). */
  step?: number
  /** answer: the chosen ask_user choice. */
  text?: string
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

/** installer: downloads in the background, installs on quit. portable: link only. dev: no checks. */
export type UpdateMode = 'installer' | 'portable' | 'dev'

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateStatus {
  mode: UpdateMode
  state: UpdateState
  /** The newer version (available, downloading, ready). */
  version?: string
  /** Release page of that version. */
  url?: string
  /** Download progress 0-100 while downloading. */
  percent?: number
  /** Last finished check (ms since epoch). */
  checkedAt?: number
  error?: string
}

/** An "always for <app / site / tool>" grant; high risk is never grantable. */
export interface AgentGrant {
  /** "app:<process>" | "mcp:<server>/<tool>" | "domain:<site>" | "scheme:mailto" */
  scope: string
  level: 'medium'
  createdAt: string
}

/** One audit log line: an executed or denied action. Typed text is only a hash + length. */
export interface AuditLine {
  t: string
  task: string
  origin: 'user-direct' | 'agent' | 'lesson' | 'routine' | 'mcp'
  action: Record<string, unknown>
  risk: 'low' | 'medium' | 'high' | 'blocked'
  decision: string
  result: 'ok' | 'error' | 'cancelled' | 'denied'
  ms: number
  reason?: string
}

/** The running OS agent (the native sidecar). */
export interface AgentImplInfo {
  /** "native" once the agent sent its ready event, else null. */
  impl: 'native' | null
  version: string | null
  protocol: 2 | null
  /** Why the agent is not running (missing exe, failed start, exit), or null. */
  error: string | null
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
  /** Curriculum unit (07 T28); none for lessons the curriculum leaves out. */
  unit?: { id: string; title: string }
  /** Skill tree state: done, the one to learn next, open, or locked by prereqs. */
  status?: 'done' | 'next' | 'open' | 'locked'
  /** Titles of the prereqs still to do (locked lessons). */
  needs?: string[]
  /** A spaced-repetition review is due (07 T29). */
  reviewDue?: boolean
  /** From a community pack the user installed (07 T32): untrusted, no "do it for me". */
  community?: boolean
}

/** One step of a recorded draft lesson (07 T31). */
export interface LessonDraftStep {
  id: string
  say: string
  /** What the step waits for, in words ("a click on Save"). */
  waitsFor: string
}

export interface LessonDraftView {
  title: string
  appId: string
  appName: string
  steps: LessonDraftStep[]
}

export interface RecordingStatus {
  phase: 'idle' | 'recording' | 'drafting' | 'draft'
  /** Steps seen so far (recording). */
  events: number
  draft: LessonDraftView | null
}

export interface LessonDraftEdit {
  title: string
  /** The steps to keep, in order, with their (edited) say lines. */
  steps: { id: string; say: string }[]
}

/** An installed community pack (07 T32). */
export interface CommunityPackInfo {
  id: string
  name: string
  version: string
  lessons: number
  /** File name or URL it was installed from. */
  source: string
  installedAt: string
  /** False when the folder is there but did not load (see the log). */
  loaded: boolean
}

export type PackInstallResult =
  | { ok: true; installed: { id: string; name: string; updated: boolean }[] }
  | { ok: false; error: string; problems?: string[] }

export type SkillActionResult = { ok: true } | { ok: false; error: string; problems?: string[] }

export interface SkillDetail {
  ok: true
  summary: SkillSummary
  /** SKILL.md as written. */
  text: string
  files: { path: string; bytes: number }[]
}

/** One skill in an archive, before it is installed (the permissions screen). */
export interface SkillPreviewInfo {
  name: string
  description: string
  version: string
  author?: string
  permissions: SkillPermissions
  apps: string[]
  triggers: string[]
  files: number
  hasSteps: boolean
  /** An installed copy will be replaced. */
  updates: boolean
}

export type SkillInstallPreview =
  | { ok: true; token: string; source: string; skills: SkillPreviewInfo[] }
  | { ok: false; error: string; problems?: string[] }

/** One app's learning progress (07 T27). */
export interface LearningApp {
  appId: string
  appName: string
  /** 0-1: mean mastery of the skills (lesson tags) its lessons teach. */
  mastery: number
  completed: number
  total: number
  /** The next unlocked lesson; null when all are done. */
  next: { lessonId: string; title: string } | null
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
  /** Every app with lessons; ones the user has started first. */
  apps: LearningApp[]
  /** Reviews due today or earlier, most overdue first. due = YYYY-MM-DD. */
  reviews: { lessonId: string; title: string; appName: string; due: string }[]
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
  /** The keyword spotter model is installed. */
  installed: boolean
  path: string
  /** Running engine: keyword spotter, or nothing listening. */
  engine: 'kws' | 'off'
  /** Why the wake word cannot run on this PC (engine failed to load), or null. */
  unavailable: string | null
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
  | {
      op: 'say'
      turnId: string
      seq: number
      text: string
      voice: string
      rate: number
      /** Voice language: a voice of another language is swapped for one that fits. */
      lang?: string
    }
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
  /** Background task list changed (Home flyout Tasks). */
  'tasks:changed': [tasks: BackgroundTask[]]
}

export type InvokeChannel = keyof InvokeChannels
export type SendChannel = keyof SendChannels
export type EventChannel = keyof EventChannels

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'face:assets',
  'face:state',
  'face:install',
  'face:calibrate',
  'assistant:query',
  'assistant:execute',
  'assistant:announce',
  'assistant:files',
  'assistant:file-remove',
  'voice:transcribe',
  'voice:dictate',
  'voice:speak',
  'voice:stt-status',
  'voice:stt-install',
  'voice:wake-state',
  'dictation:history',
  'dictation:history-delete',
  'dictation:history-clear',
  'dictation:history-copy',
  'dictation:history-insert',
  'dictation:stats',
  'dictation:stats-reset',
  'notes:list',
  'notes:add',
  'notes:update',
  'notes:delete',
  'notes:copy',
  'settings:get',
  'settings:patch',
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
  'update:status',
  'update:check',
  'update:install',
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
  'claude:status',
  'claude:settings-set',
  'claude:projects',
  'claude:project-set',
  'claude:project-remove',
  'claude:pick-folder',
  'claude:open',
  'claude:send',
  'claude:interrupt',
  'claude:close',
  'claude:permission-answer',
  'claude:hooks-preview',
  'claude:hooks-apply',
  'agent:grants-list',
  'agent:grants-revoke',
  'tasks:list',
  'tasks:cancel',
  'tasks:open',
  'tasks:answer',
  'tasks:run-again',
  'routines:list',
  'routines:update',
  'routines:remove',
  'routines:run-now',
  'audit:list',
  'helpers:journal-days',
  'helpers:journal-read',
  'helpers:journal-clear',
  'helpers:coach-status',
  'helpers:coach-reset',
  'labels:apps',
  'labels:entries',
  'labels:edit',
  'labels:remove-app',
  'labels:save-json',
  'labels:export-lumen',
  'teach:list',
  'teach:start',
  'teach:command',
  'teach:progress',
  'teach:review',
  'teach:delete',
  'teach:save-last',
  'teach:record',
  'teach:record-status',
  'teach:draft-save',
  'teach:draft-play',
  'teach:draft-discard',
  'teach:pack-list',
  'teach:pack-install-file',
  'teach:pack-install-url',
  'teach:pack-remove',
  'teach:pack-export',
  'teach:handoff-export',
  'teach:handoff-install',
  'teach:handoff-list',
  'teach:handoff-remove',
  'teach:challenge-status',
  'teach:challenge-start',
  'teach:challenge-check',
  'teach:challenge-stop',
  'teach:import-tutorial',
  'skills:list',
  'skills:get',
  'skills:set-enabled',
  'skills:set-trusted',
  'skills:save',
  'skills:create',
  'skills:delete',
  'skills:preview-file',
  'skills:preview-url',
  'skills:install',
  'skills:install-cancel',
  'skills:export',
  'skills:runs',
  'bridges:status',
  'bridges:test',
  'bridges:blender-addon',
  'bridges:obs-set',
  'bridges:obs-clear',
  'connectors:list',
  'connectors:add',
  'connectors:update',
  'connectors:remove',
  'connectors:test',
  'connectors:tools'
]

export const SEND_CHANNELS: readonly SendChannel[] = [
  'assistant:show',
  'assistant:close',
  'assistant:cancel',
  'assistant:open-link',
  'answer:show',
  'settings:open',
  'settings:window-close',
  'settings:window-minimize',
  'settings:window-maximize',
  'voice:ended',
  'voice:wake-pcm',
  'voice:barge-in',
  'voice:speaking',
  'assistant:command',
  'assistant:error',
  'assistant:correct',
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
  'a11y:keyboard-key',
  'a11y:try',
  'face:frame',
  'face:status'
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
  'voice:start',
  'voice:stop',
  'voice:hands-free',
  'voice:tts',
  'voice:wake-listen',
  'memory:changed',
  'a11y:sheet-refresh',
  'a11y:dwell-state',
  'a11y:keyboard-state',
  'assistant:focus',
  'tasks:changed'
]

/** A file dropped on the assistant bar (08 T21), as the bar shows it. */
export interface DroppedFileView {
  id: string
  name: string
  size: number
  kind: 'pdf' | 'docx' | 'text' | 'image'
}

export type FileDropResult =
  | { ok: true; files: DroppedFileView[] }
  | { ok: false; error: string; files: DroppedFileView[] }

/**
 * Invoked by the preload's dropFile only (not in INVOKE_CHANNELS): the path comes from
 * webUtils.getPathForFile, so page script cannot name an arbitrary path.
 */
export const FILE_DROPPED_CHANNEL = 'assistant:file-dropped'

/** Typed surface exposed to renderers as `window.lumen`. */
export interface LumenApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeChannels[C]['args']
  ): Promise<InvokeChannels[C]['result']>
  send<C extends SendChannel>(channel: C, ...args: SendChannels[C]): void
  on<C extends EventChannel>(channel: C, cb: (...args: EventChannels[C]) => void): () => void
  /** Shares a dropped file with Lumen for this conversation (assistant bar only). */
  dropFile(file: File): Promise<FileDropResult>
}
