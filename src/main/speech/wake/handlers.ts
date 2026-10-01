// What a spotted wake phrase or voice-cancel phrase does, whichever engine heard it.
import { holdEscape } from '../../agent/escape'
import { bus } from '../../bus'
import { dismissGuide } from '../../guides/session'
import { cancelAll } from '../../query/cancel'
import { setStatus } from '../../windows/status'

export function handleWake(engine: string): void {
  console.log(`[wake] detected (${engine}) — listening with auto-stop`)
  holdEscape('hud')
  bus.emit({ type: 'voice.started', handsFree: true })
  setStatus('listening', 'Wake word detected — listening…')
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
