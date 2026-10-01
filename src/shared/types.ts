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
  | { type: 'uia_act'; elementId: string; action: UiaAction; value?: string }
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
