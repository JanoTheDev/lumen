// Feedback nobody heard (06 T11): with no screen reader and Lumen's voice off, the announce
// policy routes to 'none', so voice command results, focus narration and lesson lines must
// be shown instead. The assistant bar shows them as a feedback line and announces them in
// its own live region.
import { loadConfig } from '../config'
import { bus } from '../bus'
import * as assistant from '../windows/assistant'
import type { AnnounceOptions } from './announce'

type Announce = (text: string, opts?: AnnounceOptions) => void

/** Wires the bar to the announce policy and shows what nobody voiced. Call once. */
export function installLiveFeedback(announce: Announce): void {
  assistant.setAnnouncer((text, opts) => announce(text, opts))
  bus.on('a11y.announce', (e) => assistant.onAnnounce(e))
}

/** A voice error from the renderer (microphone, transcription): the bar announces it. */
export function reportError(message: string): void {
  assistant.setStatus('error', message, undefined, loadConfig().a11y.timings.statusHoldMs)
}
