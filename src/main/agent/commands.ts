// Typed wrappers over the agent protocol v2 commands. Commands tied to a capability reject
// with E_UNSUPPORTED when the running agent does not report it.
import type { ElementNode, InputStep, MonitorInfo, Rect, UiaAction } from '@shared/types'
import { AgentBridge, AgentError, RequestOptions } from './bridge'
import type { AgentInitArgs } from './state'

export type CaptureMonitor = 'foreground' | 'primary' | 'all' | number

export interface CaptureArgs {
  monitor?: CaptureMonitor
  maxWidth?: number
  format?: 'jpeg' | 'png'
  quality?: number
  region?: Rect
}

export interface CaptureFrame {
  id: string
  monitor?: MonitorInfo
  width: number
  height: number
  /** Image px to physical px. */
  scale?: number
  mime: string
  data: string
  /** Physical rect actually captured when a region was asked for. */
  region?: Rect
}

export interface CaptureResult {
  frames: CaptureFrame[]
}

export interface ActiveWindowInfo {
  hwnd: number
  title: string
  process: string
  exe: string
  pid: number
  rect: Rect
  monitor: number
  isBrowser: boolean
}

export interface OcrWord {
  text: string
  rect: Rect
  conf: number
  /** Index into `lines`. */
  lineIndex?: number
}

export interface OcrResult {
  words: OcrWord[]
  lines: OcrWord[]
}

export interface UiaSnapshotArgs {
  scope: 'foreground' | number
  maxNodes?: number
  interactiveOnly?: boolean
}

export interface UiaSnapshotResult {
  snapshotId: string
  root: ElementNode
}

export interface UiaActArgs {
  elementId: string
  action: UiaAction
  value?: string
}

const CAPABILITY: Record<string, string> = {
  capture: 'capture',
  input: 'input',
  ocr: 'ocr',
  uia_snapshot: 'uia',
  uia_act: 'uia',
  announce: 'announce',
  system_info: 'system-info'
}

function send<T>(
  bridge: AgentBridge,
  cmd: string,
  args: object,
  opts?: RequestOptions
): Promise<T> {
  const cap = CAPABILITY[cmd]
  if (cap && !bridge.hasCapability(cap)) {
    return Promise.reject(
      new AgentError('E_UNSUPPORTED', `${cmd} unsupported by ${bridge.impl ?? 'agent'}`)
    )
  }
  return bridge.request<T>(cmd, args as Record<string, unknown>, opts)
}

export function capture(
  bridge: AgentBridge,
  args: CaptureArgs = {},
  opts?: RequestOptions
): Promise<CaptureResult> {
  return send(bridge, 'capture', args, opts)
}

export function activeWindow(
  bridge: AgentBridge,
  opts?: RequestOptions
): Promise<ActiveWindowInfo> {
  return bridge.request<ActiveWindowInfo>('active_window', {}, opts)
}

export function input(
  bridge: AgentBridge,
  steps: InputStep[],
  opts?: RequestOptions
): Promise<{ done: boolean }> {
  return send(bridge, 'input', { steps }, opts)
}

export function uiaSnapshot(
  bridge: AgentBridge,
  args: UiaSnapshotArgs = { scope: 'foreground' },
  opts?: RequestOptions
): Promise<UiaSnapshotResult> {
  return send(bridge, 'uia_snapshot', args, opts)
}

export function uiaAct(
  bridge: AgentBridge,
  args: UiaActArgs,
  opts?: RequestOptions
): Promise<{ done: boolean; fallbackUsed?: boolean }> {
  return send(bridge, 'uia_act', args, opts)
}

export function ocr(
  bridge: AgentBridge,
  args: { frameId?: string; region?: Rect } = {},
  opts?: RequestOptions
): Promise<OcrResult> {
  return send(bridge, 'ocr', args, opts)
}

export async function announce(
  bridge: AgentBridge,
  text: string,
  priority: 'polite' | 'assertive' = 'polite',
  opts?: RequestOptions
): Promise<{ spoken: boolean; via?: string }> {
  const r = await send<{ spoken?: boolean; via?: string } | null>(
    bridge,
    'announce',
    { text, priority },
    opts
  )
  return { spoken: !!r?.spoken, via: r?.via }
}

export function cancel(bridge: AgentBridge, targetId: number): Promise<void> {
  return bridge.cancel(targetId)
}

export async function init(
  bridge: AgentBridge,
  state: AgentInitArgs,
  opts?: RequestOptions
): Promise<void> {
  await send(bridge, 'init', state, opts)
}

export function ping(bridge: AgentBridge, opts?: RequestOptions): Promise<{ t: number }> {
  return bridge.request<{ t: number }>('ping', {}, opts)
}

export interface MarksRenderArgs {
  frameId: string
  /** Physical px rects. */
  marks: { n: number; rect: Rect }[]
  maxWidth?: number
  quality?: number
}

export interface MarksRenderResult {
  data: string
  width: number
  height: number
  mime: string
  count: number
}

/** A cached frame re-encoded with numbered marks drawn in (agent-side). */
export function marksRender(
  bridge: AgentBridge,
  args: MarksRenderArgs,
  opts?: RequestOptions
): Promise<MarksRenderResult> {
  return send(bridge, 'marks_render', args, opts)
}

export interface SystemInfo {
  /** Lumen runs as administrator (the agent shares its token). */
  elevated: boolean
  /** Windows build number, e.g. 26200; null when unreadable. */
  osBuild: number | null
  /** Update build revision (UBR). */
  osRevision: number | null
}

export function systemInfo(bridge: AgentBridge, opts?: RequestOptions): Promise<SystemInfo> {
  return send(bridge, 'system_info', {}, opts)
}
