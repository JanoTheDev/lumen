// Voice entry points. The assistant window hosts the voice controller (assistant/VoiceHost),
// so every call goes to it; this module only keeps the voice wiring in one place.
import type { BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { sendTo } from './registry'
import { bus } from '../bus'
import * as assistant from './assistant'

export function get(): BrowserWindow | null {
  return assistant.get()
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(get(), channel, ...args)
}

export function show(): void {
  assistant.open('listening')
}

export function hide(): void {
  assistant.turnEnded()
}

/** Hands-free uses the same auto-stop-on-silence path as wake-word activation. */
export function startVoice(handsFree: boolean): void {
  send('voice:start', { mode: handsFree ? 'hands-free' : 'hold' })
}

export function startDictation(): void {
  send('voice:start', { mode: 'dictation' })
}

export function dictationHandsFree(): void {
  send('voice:hands-free')
}

export function stopVoice(): void {
  send('voice:stop')
}

bus.on('voice.started', (e) => {
  show()
  startVoice(e.handsFree)
})
bus.on('dictation.started', () => {
  show()
  startDictation()
})
bus.on('dictation.hands-free', () => dictationHandsFree())
bus.on('voice.stopped', (e) => {
  if (!e.ended) stopVoice()
})
bus.on('voice.cancelled', () => send('assistant:cancel-request'))
