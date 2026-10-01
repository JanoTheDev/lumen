// Feedback nobody heard (06 T11): with no screen reader and Lumen's voice off, the announce
// policy routes to 'none', so voice command results, focus narration and lesson lines must
// be shown instead. The assistant bar (ui v2) shows them as a feedback line and announces
// them in its own live region; the old status bubble (v1) shows them as a status line.
import type { AppEvent } from '@shared/events'
import { bus } from '../bus'
import { loadConfig } from '../config'
import * as assistant from '../windows/assistant'
import { setStatus } from '../windows/status'
import { uiV2 } from '../windows/ui-mode'
import type { AnnounceOptions } from './announce'

type AnnounceEvent = Extract<AppEvent, { type: 'a11y.announce' }>
type Announce = (text: string, opts?: AnnounceOptions) => void

/** Kinds the old surfaces show already (errors, confirms) or that need no line (phases). */
const V1_SKIP = new Set(['error', 'confirm', 'phase', 'answer'])

/** v1: whether an announcement becomes a status line. */
export function v1ShowsLine(e: AnnounceEvent, captions: boolean): boolean {
  const kind = e.kind ?? 'status'
  if (V1_SKIP.has(kind)) return false
  if (kind === 'scan' && !captions) return false
  return captions || e.via === 'none' || e.via === undefined
}

let announceFn: Announce = () => {}

/** Wires the bar to the announce policy and shows what nobody voiced. Call once. */
export function installLiveFeedback(announce: Announce): void {
  announceFn = announce
  assistant.setAnnouncer((text, opts) => announce(text, opts))
  bus.on('a11y.announce', (e) => {
    if (uiV2()) return assistant.onAnnounce(e)
    const cfg = loadConfig()
    if (v1ShowsLine(e, cfg.a11y.captions))
      setStatus('answer', e.text, undefined, cfg.a11y.timings.statusHoldMs)
  })
}

/** A voice error from the renderer (microphone, transcription): error row + announcement. */
export function reportError(message: string): void {
  setStatus('error', message, undefined, loadConfig().a11y.timings.statusHoldMs)
  // The bar announces its own errors; the v1 bubble does not.
  if (!uiV2()) announceFn(message, { kind: 'error' })
}
