// What the lesson engine needs from the rest of the app (plans 07 tasks T12). The engine and
// the checks only see these interfaces; teach/wire.ts builds the real ones from the agent,
// the verifier, TTS and the bus. The defaults do nothing, so everything runs in tests.
import type { AssistantState, ScreenScene } from '@shared/events'
import type { ElementNode, Point, Rect } from '@shared/types'
import type { DoAction, ElementMatch, LessonTarget, UiaEventKind } from './lesson'
import type { Skill } from './registry'

export type CheckResult = 'pass' | 'fail' | 'unknown'

/** A scene in global logical px (the screen layer splits it per display). */
export type LessonScene = Omit<ScreenScene, 'monitorId'>

export interface Frame {
  id: string
  /** Opaque data the port's diff understands (low-res gray pixels in the real port). */
  sig?: unknown
}

export interface ScreenPort {
  /** A frame of the foreground monitor; low = small and cheap, for change detection. */
  capture(opts?: { low?: boolean }): Promise<Frame | null>
  /** Changed fraction between two frames (0 = same, 1 = all different); null = unknown. */
  diff(a: Frame, b: Frame): number | null
  /** null clears what the lesson drew. */
  emitScene(scene: LessonScene | null): void
  /** null hands the assistant bar back. */
  emitState(state: AssistantState | null): void
}

export interface ResolvedTarget {
  /** Logical px; absent for shortcut targets (nothing to point at). */
  rect?: Rect
  /** Where the buddy goes (logical px). */
  point: Point
  elementId?: string
  source: 'element' | 'text' | 'region' | 'shortcut' | 'mark' | 'point'
  /** Spoken fallback ("in the Outliner"). */
  where?: string
}

export interface TargetPort {
  resolveTarget(
    target: LessonTarget,
    ctx: { skill?: Skill | null; signal?: AbortSignal }
  ): Promise<ResolvedTarget | null>
}

export interface VerifyPort {
  /** A yes/no question about two frames from ScreenPort.capture. */
  vision(
    prompt: string,
    beforeFrameId: string,
    afterFrameId: string,
    signal?: AbortSignal
  ): Promise<CheckResult>
}

/** A UIA event as the agent reports it (focus-changed, invoke, value-changed …). */
export interface UiaEvent {
  kind: UiaEventKind
  element: { name?: string; role?: string; automationId?: string; value?: string }
}

export interface UiaPort {
  find(query: ElementMatch): Promise<ElementNode[]>
  /** Delivers matching events until the returned function is called. */
  subscribe(kinds: UiaEventKind[], cb: (e: UiaEvent) => void): () => void
}

export interface WindowInfo {
  title: string
  process?: string
  url?: string
}

export interface WindowPort {
  activeWindow(): Promise<WindowInfo | null>
}

/** Observed (never suppressed) key combos while a step is active; 02 `key-combo`. */
export interface KeyPort {
  available(): boolean
  onCombo(cb: (combo: string) => void): () => void
}

export interface ExecPort {
  /** Runs lesson-originated actions; resolves false when any of them failed. */
  run(actions: DoAction[], ctx: { skill?: Skill | null; signal: AbortSignal }): Promise<boolean>
}

export interface SpeakPort {
  say(text: string, opts: { interruptible: boolean }): void
}

export interface AnnouncePort {
  announce(text: string, priority: 'polite' | 'assertive'): void
}

export interface BridgePort {
  /** 'unknown' when no bridge for the app is connected. */
  query(
    appId: string,
    question: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CheckResult>
}

export interface LessonEvents {
  stepStarted(lessonId: string, step: number): void
  stepCompleted(lessonId: string, step: number): void
  done(lessonId: string, completed: boolean): void
}

export interface Ports {
  screen: ScreenPort
  target: TargetPort
  verify: VerifyPort
  uia: UiaPort
  window: WindowPort
  keys: KeyPort
  exec: ExecPort
  speak: SpeakPort
  announce: AnnouncePort
  bridge: BridgePort
  events: LessonEvents
  log(tag: string, msg: string): void
}

const off = (): void => {}

/** Ports that do nothing; pass overrides for the parts a test drives. */
export function noopPorts(over: Partial<Ports> = {}): Ports {
  return {
    screen: {
      capture: async () => null,
      diff: () => null,
      emitScene: off,
      emitState: off
    },
    target: { resolveTarget: async () => null },
    verify: { vision: async () => 'unknown' },
    uia: { find: async () => [], subscribe: () => off },
    window: { activeWindow: async () => null },
    keys: { available: () => false, onCombo: () => off },
    exec: { run: async () => false },
    speak: { say: off },
    announce: { announce: off },
    bridge: { query: async () => 'unknown' },
    events: { stepStarted: off, stepCompleted: off, done: off },
    log: off,
    ...over
  }
}
