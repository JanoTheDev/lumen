// What a spotted wake phrase or voice-cancel phrase does, whichever engine heard it.
import { holdEscape } from '../../agent/escape'
import { bus } from '../../bus'
import { dismissGuide } from '../../guides/session'
import { loadConfig } from '../../config'
import { cancelAll } from '../../query/cancel'
import { setStatus } from '../../windows/status'

export function handleWake(engine: string): void {
  console.log(`[wake] detected (${engine}) — listening with auto-stop`)
  holdEscape('hud')
  bus.emit({ type: 'voice.started', handsFree: true })
  setStatus('listening', 'Wake word detected — listening…')
}

/** The user talked over a spoken answer: the renderer stopped playback, now listen. */
export function handleBargeIn(): void {
  if (!loadConfig().voice.bargeIn) return
  console.log('[barge-in] user spoke over the answer — listening with auto-stop')
  holdEscape('hud')
  bus.emit({ type: 'voice.started', handsFree: true })
  setStatus('listening', 'Listening…')
}

export function handleVoiceCancel(phrase: string): void {
  console.log(`[cancel-voice] matched "${phrase}"`)
  if (cancelAll()) {
    setStatus('error', 'Cancelled by voice', undefined, 1600)
  } else {
    // Not in a query: close any active UI.
    bus.emit({ type: 'voice.cancelled' })
    dismissGuide()
  }
}
