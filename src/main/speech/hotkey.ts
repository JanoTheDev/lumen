// Wires the assistant hotkey gestures (speech/activation.ts) to the voice renderer and status.
import { bus } from '../bus'
import { loadConfig } from '../config'
import { holdEscape } from '../agent/escape'
import { startSpeculativeCapture } from '../query/context'
import { captureContext } from '../query/capture'
import * as hud from '../windows/hud'
import { setStatus } from '../windows/status'
import { AssistantActivation } from './activation'

const activation = new AssistantActivation(
  {
    start(handsFree) {
      holdEscape('hud')
      bus.emit({ type: 'voice.started', handsFree })
      setStatus('listening', handsFree ? 'Listening (hands-free)…' : 'Listening…')
    },
    handsFree() {
      hud.send('voice:hands-free')
      setStatus('listening', 'Listening… pause or tap to send')
    },
    stop() {
      bus.emit({ type: 'voice.stopped' })
      setStatus('transcribing', 'Transcribing', { index: 1, total: 3 })
      // Capture while speech is transcribed; runQuery awaits this promise if it is fresh.
      startSpeculativeCapture(() => captureContext(true))
    }
  },
  () => (loadConfig().handsFreeMode ? 'tap' : 'hold')
)

export function onAssistantHotkeyDown(): void {
  activation.down()
}

export function onAssistantHotkeyUp(): void {
  activation.up()
}

/** A hands-free recording ended in the renderer (silence, no speech, error). */
export function onRecordingEnded(): void {
  activation.reset()
}

bus.on('voice.cancelled', () => activation.reset())
bus.on('query.started', () => activation.reset())
