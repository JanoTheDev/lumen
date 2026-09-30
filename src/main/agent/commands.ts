// Typed wrappers over the agent protocol v2 commands. On a v1 agent the few commands with a
// v1 equivalent are mapped; everything else rejects with E_UNSUPPORTED.
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
  /** Absent on a v1 agent, which reports no monitor geometry. */
  monitor?: MonitorInfo
  width: number
  height: number
  /** Image px to physical px; absent on a v1 agent. */
  scale?: number
  mime: string
  data: string
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

/** v1 agents only know the title. */
export type ActiveWindowResult = Partial<ActiveWindowInfo> & { title: string }

export interface OcrWord {
  text: string
  rect: Rect
  conf: number
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
  announce: 'announce'
}

function v2Only<T>(
  bridge: AgentBridge,
  cmd: string,
  args: object,
  opts?: RequestOptions
): Promise<T> {
  if (bridge.protocol !== 2) {
    return Promise.reject(new AgentError('E_UNSUPPORTED', `${cmd} needs agent protocol v2`))
  }
  const cap = CAPABILITY[cmd]
  if (cap && !bridge.hasCapability(cap)) {
    return Promise.reject(
      new AgentError('E_UNSUPPORTED', `${cmd} unsupported by ${bridge.impl ?? 'agent'}`)
    )
  }
  return bridge.request<T>(cmd, args as Record<string, unknown>, opts)
}

let v1FrameSeq = 0

/** Width/height from a base64 JPEG's SOF segment; 0x0 when it cannot be read. */
export function jpegSize(b64: string): { width: number; height: number } {
  const buf = Buffer.from(b64.slice(0, 65536), 'base64')
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return { width: 0, height: 0 }
}

export async function capture(
  bridge: AgentBridge,
  args: CaptureArgs = {},
  opts?: RequestOptions
): Promise<CaptureResult> {
  if (bridge.protocol === 2) return v2Only<CaptureResult>(bridge, 'capture', args, opts)
  const data = await bridge.request<string>('screenshot', {}, opts)
  const { width, height } = jpegSize(data)
  return {
    frames: [{ id: `v1-${++v1FrameSeq}`, width, height, mime: 'image/jpeg', data }]
  }
}

export async function activeWindow(
  bridge: AgentBridge,
  opts?: RequestOptions
): Promise<ActiveWindowResult> {
  if (bridge.protocol === 2) return bridge.request<ActiveWindowInfo>('active_window', {}, opts)
  const title = await bridge.request<unknown>('active_window', {}, opts)
  return { title: typeof title === 'string' ? title : 'Unknown' }
}

export function input(
  bridge: AgentBridge,
  steps: InputStep[],
  opts?: RequestOptions
): Promise<{ done: boolean }> {
  return v2Only(bridge, 'input', { steps }, opts)
}

export function uiaSnapshot(
  bridge: AgentBridge,
  args: UiaSnapshotArgs = { scope: 'foreground' },
  opts?: RequestOptions
): Promise<UiaSnapshotResult> {
  return v2Only(bridge, 'uia_snapshot', args, opts)
}

export function uiaAct(
  bridge: AgentBridge,
  args: UiaActArgs,
  opts?: RequestOptions
): Promise<{ done: boolean; fallbackUsed?: boolean }> {
  return v2Only(bridge, 'uia_act', args, opts)
}

export function ocr(
  bridge: AgentBridge,
  args: { frameId?: string; region?: Rect } = {},
  opts?: RequestOptions
): Promise<OcrResult> {
  return v2Only(bridge, 'ocr', args, opts)
}

export async function announce(
  bridge: AgentBridge,
  text: string,
  priority: 'polite' | 'assertive' = 'polite',
  opts?: RequestOptions
): Promise<void> {
  await v2Only(bridge, 'announce', { text, priority }, opts)
}

export function cancel(bridge: AgentBridge, targetId: number): Promise<void> {
  return bridge.cancel(targetId)
}

export async function init(
  bridge: AgentBridge,
  state: AgentInitArgs,
  opts?: RequestOptions
): Promise<void> {
  await v2Only(bridge, 'init', state, opts)
}

export async function ping(bridge: AgentBridge, opts?: RequestOptions): Promise<{ t: number }> {
  if (bridge.protocol === 2) return bridge.request<{ t: number }>('ping', {}, opts)
  await bridge.request('ping', {}, opts)
  return { t: Date.now() }
}
