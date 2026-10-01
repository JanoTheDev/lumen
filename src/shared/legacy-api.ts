// Compatibility surface for renderers written before `window.lumen`. Built on the typed
// channel table so it cannot reach anything the table does not allow.
import type {
  EventChannel,
  EventChannels,
  LumenApi,
  SendChannel,
  SendChannels,
  WakeModelProgress
} from './channels'
import type { GuideStep, LocateItem } from './types'

/** @deprecated New renderer code uses `window.lumen`. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createLegacyApi(lumen: LumenApi) {
  const on = <C extends EventChannel>(
    channel: C,
    cb: (...args: EventChannels[C]) => void
  ): (() => void) => lumen.on(channel, cb)
  const send = <C extends SendChannel>(channel: C, ...args: SendChannels[C]): void =>
    lumen.send(channel, ...args)

  return {
    query: (prompt: string, opts?: { lowDetail?: boolean }) =>
      lumen.invoke('assistant:query', prompt, opts),
    executeAction: (actions: unknown[]) => lumen.invoke('assistant:execute', actions),
    hideHighlights: () => lumen.invoke('screen:hide'),
    closeHUD: () => send('assistant:close'),
    onShowHighlights: (cb: (steps: GuideStep[]) => void) => on('screen:highlights', cb),
    onClearHighlights: (cb: () => void) => on('screen:clear', cb),
    onShowPointer: (cb: (data: { x: number; y: number; text: string }) => void) =>
      on('screen:pointer', cb),
    onShowLocate: (cb: (items: LocateItem[]) => void) => on('screen:locate', cb),
    showHUD: () => send('assistant:show'),
    showAnswerOverlay: (text: string) => send('answer:show', text),
    hideAnswerOverlay: () => send('answer:hide'),
    onShowAnswer: (cb: (text: string) => void) => on('answer:text', cb),
    onCancelRequest: (cb: () => void) => on('assistant:cancel-request', cb),
    transcribe: (audio: ArrayBuffer, opts?: { dictation?: boolean }) =>
      lumen.invoke('voice:transcribe', audio, opts),
    dictate: (text: string) => lumen.invoke('voice:dictate', text),
    resizeAnswerOverlay: (h: number) => send('answer:resize', h),
    getConfig: () => lumen.invoke('settings:get'),
    saveConfig: (patch: Record<string, unknown>) => lumen.invoke('settings:patch', patch),
    openSettings: () => send('settings:open'),
    openLink: (url: string) => send('assistant:open-link', url),
    cancelCurrent: () => send('assistant:cancel'),
    onConfigChanged: (cb: (cfg: Record<string, unknown>) => void) => on('settings:changed', cb),
    wakeModelStatus: () => lumen.invoke('wake:model-status'),
    wakeModelInstall: () => lumen.invoke('wake:model-install'),
    onWakeModelProgress: (cb: (p: WakeModelProgress) => void) => on('wake:model-progress', cb),
    onStatus: (
      cb: (m: { kind: string; text: string; step?: { index: number; total: number } }) => void
    ) => on('status:set', cb),
    onStatusHide: (cb: () => void) => on('status:hide', cb),
    settingsWindowClose: () => send('settings:window-close'),
    settingsWindowMinimize: () => send('settings:window-minimize'),
    settingsWindowMaximize: () => send('settings:window-maximize'),
    announceAction: (summary: string, confidence?: string) =>
      lumen.invoke('assistant:announce', summary, confidence),
    ttsSpeak: (text: string) => lumen.invoke('voice:speak', text),
    onTtsAudio: (cb: (p: { mime: string; data: string }) => void) => on('voice:tts-audio', cb),
    guidesList: () => lumen.invoke('guides:list'),
    guidesSaveLast: (name: string) => lumen.invoke('guides:save-last', name),
    guidesReplay: (id: string) => lumen.invoke('guides:replay', id),
    guidesDelete: (id: string) => lumen.invoke('guides:delete', id),
    onRunQuery: (cb: (text: string) => void) => on('assistant:run-query', cb),
    onDwellProgress: (
      cb: (data: { x: number; y: number; progress: number; active: boolean }) => void
    ) => on('screen:dwell', cb)
  }
}

export type LegacyApi = ReturnType<typeof createLegacyApi>
