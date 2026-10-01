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
  /** Win32 class of the window (newer agents only). */
  className?: string
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
  /** Lets set_value write a password field: the user's own direct input only. */
  allowPassword?: boolean
}

const CAPABILITY: Record<string, string> = {
  capture: 'capture',
  input: 'input',
  ocr: 'ocr',
  uia_snapshot: 'uia',
  uia_act: 'uia',
  announce: 'announce',
  system_info: 'system-info',
  tts_voices: 'tts',
  tts_synthesize: 'tts',
  audio_output: 'audio-output',
  audio_unmute: 'audio-output',
  audio_set_volume: 'audio-volume',
  ptt_mouse: 'ptt-mouse',
  switch_keys: 'switch',
  browser_url: 'browser-url'
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

/** `focus_info`: the foreground window plus the keyboard-focused element. */
export interface FocusInfoResult {
  process: string
  title: string
  /** false: UIA could not read the focused element (the other fields are empty). */
  uia: boolean
  role: string
  name: string
  editable: boolean
  password: boolean
  valueTail: string
  /** UIA ClassName of the focused element (newer agents only). */
  className?: string
  /** Win32 class of the foreground window (newer agents only). */
  windowClass?: string
}

export function focusInfo(bridge: AgentBridge, opts?: RequestOptions): Promise<FocusInfoResult> {
  return bridge.request<FocusInfoResult>('focus_info', {}, opts)
}

export function input(
  bridge: AgentBridge,
  steps: InputStep[],
  opts?: RequestOptions,
  /** allowPassword: the user's own direct input (a11y keyboards); never for agent or lessons. */
  flags: { allowPassword?: boolean } = {}
): Promise<{ done: boolean }> {
  return send(
    bridge,
    'input',
    { steps, ...(flags.allowPassword ? { allowPassword: true } : {}) },
    opts
  )
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

export interface TtsVoice {
  id: string
  name: string
  lang: string
  gender: 'male' | 'female' | 'unknown'
}

export interface TtsSynthesizeArgs {
  text: string
  /** Voice id or display name; empty = the system default. */
  voice?: string
  /** 0.5–6. */
  rate?: number
  /** 0–2, 1 = the voice's own pitch. */
  pitch?: number
  /** `text` is SSML. */
  ssml?: boolean
}

export interface TtsAudio {
  mime: 'audio/wav'
  /** Base64 WAV. */
  data: string
  bytes: number
  /** Display name of the voice used. */
  voice: string
}

/** Installed OneCore voices (Windows.Media.SpeechSynthesis). */
export async function ttsVoices(bridge: AgentBridge, opts?: RequestOptions): Promise<TtsVoice[]> {
  const r = await send<{ voices?: TtsVoice[] }>(bridge, 'tts_voices', {}, opts)
  return Array.isArray(r?.voices) ? r.voices : []
}

/** Renders speech to WAV agent-side; nothing is played there. */
export function ttsSynthesize(
  bridge: AgentBridge,
  args: TtsSynthesizeArgs,
  opts?: RequestOptions
): Promise<TtsAudio> {
  return send(bridge, 'tts_synthesize', args, { timeoutMs: 15_000, ...opts })
}

export interface AudioOutputState {
  muted: boolean
  /** 0..1 master volume of the default playback device. */
  volume: number
}

export function audioOutput(bridge: AgentBridge, opts?: RequestOptions): Promise<AudioOutputState> {
  return send(bridge, 'audio_output', {}, opts)
}

export async function audioUnmute(bridge: AgentBridge, opts?: RequestOptions): Promise<void> {
  await send(bridge, 'audio_unmute', {}, opts)
}

/** Sets the master volume (0..1) of the default playback device; returns the level now. */
export function audioSetVolume(
  bridge: AgentBridge,
  level: number,
  opts?: RequestOptions
): Promise<{ volume: number }> {
  return send(bridge, 'audio_set_volume', { level }, opts)
}

/** Dictation push-to-talk on a mouse button (reported as dictation-down / -up); "" = off. */
export function pttMouse(
  bridge: AgentBridge,
  button: '' | 'middle' | 'x1' | 'x2',
  opts?: RequestOptions
): Promise<{ button: string }> {
  return send(bridge, 'ptt_mouse', { button }, opts)
}

export type SwitchMouseButton = 'left' | 'right' | 'middle' | 'x1' | 'x2'

/**
 * Switch access keys on the agent's low-level hooks: physical down and up of these keys
 * (Electron accelerator names) and mouse buttons are suppressed and reported as
 * `switch {index, down}` (index into keys, then mouse). Empty lists release them.
 */
export function switchKeys(
  bridge: AgentBridge,
  keys: string[],
  mouse: SwitchMouseButton[] = [],
  opts?: RequestOptions
): Promise<{ keys: string[]; mouse: string[] }> {
  return send(bridge, 'switch_keys', { keys, mouse }, opts)
}

export interface BrowserUrl {
  /** The page address from the address bar; null when it holds no web address. */
  url: string | null
  /** Browser process image name, e.g. "chrome.exe". */
  browser: string
  title: string
  hwnd: number
}

/** The front browser window's address-bar URL (UIA, nothing typed). E_NOT_FOUND: no browser. */
export function browserUrl(bridge: AgentBridge, opts?: RequestOptions): Promise<BrowserUrl> {
  return send(bridge, 'browser_url', {}, { timeoutMs: 2500, ...opts })
}
