// Types shared by main, preload and renderer. Pure TS: no electron or node imports.

export interface Point {
  x: number
  y: number
}

/** Rectangle {x,y,w,h}. Every bbox in code and prompts uses this shape. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface MonitorInfo {
  id: number
  /** Physical px on the virtual desktop. */
  rect: Rect
  scale: number
  primary: boolean
}

export type ElementPattern = 'invoke' | 'toggle' | 'select' | 'expand' | 'value' | 'scroll' | 'text'

/** UI Automation element from an agent snapshot (physical px). */
export interface ElementNode {
  id: string
  role: string
  name: string
  automationId?: string
  value?: string
  rect: Rect
  monitorId: number
  enabled: boolean
  focused?: boolean
  patterns: ElementPattern[]
  children?: ElementNode[]
}

/**
 * What the model can point at, in priority order. Points and rects are image px of the
 * named frame. `rect` covers areas (a panel, a cluster of rows) that a point cannot.
 */
export type Target =
  | { kind: 'element'; id: string }
  | { kind: 'mark'; n: number }
  | { kind: 'text'; text: string; nth?: number }
  | { kind: 'point'; x: number; y: number; frame: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; frame: string }
  /** A named area of the foreground app from its skill pack's regions.json (C8). */
  | { kind: 'region'; name: string }

export type Risk = 'low' | 'medium' | 'high'

export type ResponseMode = 'answer' | 'guide' | 'action' | 'text_insert' | 'locate'

export type MouseButton = 'left' | 'right'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export type InputStep =
  | { t: 'move'; x: number; y: number }
  | { t: 'click'; button: MouseButton; x?: number; y?: number; count?: number }
  | { t: 'drag'; from: Point; to: Point }
  | { t: 'scroll'; dx: number; dy: number; x?: number; y?: number }
  | { t: 'type'; text: string }
  | { t: 'keys'; combo: string }
  | { t: 'wait'; ms: number }

export type UiaAction =
  | 'invoke'
  | 'toggle'
  | 'select'
  | 'expand'
  | 'collapse'
  | 'focus'
  | 'set_value'
  | 'scroll_into_view'

/**
 * One action the model (or a lesson) asks Lumen to perform. Coordinates and bboxes are
 * screenshot image px; the executor converts them before the agent sees them.
 */
export type Action =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: MouseButton }
  | { type: 'click_target'; target: Target; button?: MouseButton; description?: string }
  | { type: 'click_bbox'; bbox: Rect; button?: MouseButton; description?: string }
  | { type: 'click_element'; text: string; button?: MouseButton; bbox?: Rect }
  | { type: 'click_nth_element'; text: string; n: number; button?: MouseButton }
  | { type: 'type'; text: string }
  | { type: 'hotkey'; keys: string[] }
  | { type: 'open_url'; url: string }
  | { type: 'navigate_url'; url: string }
  | { type: 'focus_browser' }
  | { type: 'scroll'; direction: ScrollDirection; amount?: number; x?: number; y?: number }
  | {
      type: 'uia_act'
      elementId: string
      action: UiaAction
      value?: string
      /** Name of the element (policy risk names, logs). */
      description?: string
    }
  | { type: 'input'; steps: InputStep[] }

export type ActionType = Action['type']

export type Confidence = 'high' | 'medium' | 'low'

export interface GuideStep {
  label: string
  target_hint: string
  bbox?: Rect
  target?: Target
  detail?: string
}

export interface SavedGuide {
  id: string
  name: string
  task: string
  steps: GuideStep[]
  createdAt: number
}

export interface LocateItem {
  label: string
  /** Image px from the model (rect/point targets); logical px once presented. */
  bbox?: Rect
  description?: string
  target?: Target
}

export interface FollowUp {
  query: string
  delay_ms: number
}

/**
 * Parsed model reply for one turn. `cancelled` marks a turn the user stopped.
 * Answer: `text` is what the answer card shows (markdown ?? spoken), `spoken` is for TTS,
 * `clarify` marks a question back to the user.
 */
export type ModelResponse =
  | {
      mode: 'answer'
      text: string
      spoken?: string
      markdown?: string
      point?: Target
      clarify?: boolean
      confidence?: Confidence
      cancelled?: boolean
    }
  | { mode: 'guide'; steps: GuideStep[]; confidence?: Confidence }
  | {
      mode: 'action'
      actions: Action[]
      summary?: string
      follow_up?: FollowUp
      risk?: Risk
      confidence?: Confidence
    }
  | {
      mode: 'text_insert'
      text: string
      target_hint: string
      targetField?: Target
      confidence?: Confidence
    }
  | { mode: 'locate'; items: LocateItem[]; notFoundReason?: string; confidence?: Confidence }

/** Skills (CONTRACTS C10): who a skill comes from, which decides how much Lumen trusts it. */
export type SkillTrust = 'builtin' | 'mine' | 'community-untrusted' | 'community-trusted'

/** C10 `permissions`; anything not granted here is E_DENIED when the skill runs. */
export interface SkillPermissions {
  /** Click / type / keys in the skill's `apps` (any app when `apps` is empty). */
  input: boolean
  /** URL patterns open_url / fetch may use, e.g. "https://*.youtube.com". */
  network: string[]
  files: { read: string[]; write: string[] }
  /** MCP server ids. */
  connectors: string[]
  /** May read profile fields from memory (form filling). */
  profile: boolean
  /** Confirm every action, whatever the trust level. */
  risky: boolean
  /** Background runs may capture the screen (C10 v2). */
  screen: boolean
}

export interface SkillParam {
  type: 'string' | 'number' | 'boolean'
  default?: string | number | boolean
  description?: string
  enum?: (string | number)[]
}

/** The parsed SKILL.md frontmatter (C10 + C10 v2). */
export interface SkillManifest {
  name: string
  description: string
  when_to_use?: string
  version: string
  author?: string
  license?: string
  apps: string[]
  triggers: string[]
  params: Record<string, SkillParam>
  permissions: SkillPermissions
  context: 'foreground' | 'background'
  model?: 'fast' | 'main' | 'planning'
  tools?: string[]
}

/** One skill as Settings shows it. */
export interface SkillSummary {
  name: string
  description: string
  when_to_use?: string
  version: string
  author?: string
  apps: string[]
  triggers: string[]
  permissions: SkillPermissions
  context: 'foreground' | 'background'
  trust: SkillTrust
  /** Where it was loaded from: the app's own skills, an app pack's, or the user's folder. */
  origin: 'builtin' | 'app-pack' | 'user'
  enabled: boolean
  /** It replaces a skill with the same name from an earlier location. */
  overrides?: 'builtin' | 'app-pack'
  /** Installed from a `.lumen` file or link. */
  source?: string
  /** Bundled steps.json (runs without the model once the runner lands). */
  hasSteps: boolean
  /** Loader warnings (long body, unknown keys). */
  warnings: string[]
}

/** Background tasks (CONTRACTS C11, 08 T26–T30). */
export type BackgroundTaskPhase =
  | 'queued'
  | 'running'
  | 'needs-foreground'
  | 'asking'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type BackgroundArtifact =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'link'; url: string; title?: string }

export interface BackgroundTask {
  id: string
  title: string
  /** The request as given (Run again starts it anew). */
  prompt: string
  skill?: string
  origin: 'voice' | 'agent' | 'routine'
  phase: BackgroundTaskPhase
  /** Newest last, capped. */
  progress: string[]
  result?: { summary: string; report?: string; artifacts?: BackgroundArtifact[] }
  counters: { modelCalls: number; costUsd: number; startedAt: number }
  /** A queued question (ask_user, a cap reached, request_foreground declined for later). */
  question?: { text: string; choices?: string[] }
  /** spawn_task child: the parent's id (children cannot spawn). */
  parentId?: string
  /** A routine's run (08 T22): the routine's id (its pre-approved shapes apply). */
  routineId?: string
  endedAt?: number
  /** Finished and not looked at yet (the tray badge counts these). */
  unseen?: boolean
}
