// IPC channel names and payload types (CONTRACTS C5). Zod-free so the sandboxed preload can
// import it; the matching validators live in ./ipc.ts and run in main.
import type { ConfigPatch } from './config'
import type { GuideStep, LocateItem, ModelResponse, Point, SavedGuide } from './types'

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
  'wake:model-status': { args: []; result: { installed: boolean; path: string } }
  'wake:model-install': { args: []; result: { ok: boolean; error?: string } }
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
  'screen:dwell': [data: { x: number; y: number; progress: number; active: boolean }]
  'answer:text': [text: string]
  'assistant:cancel-request': []
  'assistant:run-query': [text: string]
  'settings:changed': [config: Record<string, unknown>]
  'wake:model-progress': [progress: WakeModelProgress]
  'voice:stt-model-progress': [progress: WakeModelProgress]
  'status:set': [message: StatusMessage]
  'status:hide': []
  'voice:tts-audio': [audio: { mime: string; data: string }]
  'voice:start': [opts: { mode: VoiceStartMode }]
  'voice:stop': []
  /** The open dictation recording becomes hands-free (ends on silence). */
  'voice:hands-free': []
  'voice:tts': [msg: TtsMessage]
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
  'settings:get',
  'settings:patch',
  'screen:hide',
  'guides:list',
  'guides:save-last',
  'guides:replay',
  'guides:delete',
  'wake:model-status',
  'wake:model-install'
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
  'settings:window-maximize'
]

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'screen:highlights',
  'screen:clear',
  'screen:pointer',
  'screen:locate',
  'screen:dwell',
  'answer:text',
  'assistant:cancel-request',
  'assistant:run-query',
  'settings:changed',
  'wake:model-progress',
  'voice:stt-model-progress',
  'status:set',
  'status:hide',
  'voice:tts-audio',
  'voice:start',
  'voice:stop',
  'voice:hands-free',
  'voice:tts'
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
