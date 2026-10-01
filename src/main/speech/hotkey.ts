// Wires the assistant hotkey gestures (speech/activation.ts) to the voice renderer and status.
import { bus } from '../bus'
import { loadConfig } from '../config'
import { holdEscape, keepEscapeWhile } from '../agent/escape'
import { startSpeculativeCapture } from '../query/context'
import { captureContext } from '../query/capture'
import * as assistant from '../windows/assistant'
import { AssistantActivation } from './activation'

const activation = new AssistantActivation(
  {
    start(handsFree) {
      holdEscape('hud')
      bus.emit({ type: 'voice.started', handsFree })
      assistant.setStatus('listening', handsFree ? 'Listening (hands-free)…' : 'Listening…')
    },
    handsFree() {
      assistant.send('voice:hands-free')
      assistant.setStatus('listening', 'Listening… pause or tap to send')
    },
    stop() {
      bus.emit({ type: 'voice.stopped' })
      assistant.setStatus('transcribing', 'Transcribing', { index: 1, total: 3 })
      // Capture while speech is transcribed; runQuery awaits this promise if it is fresh.
      startSpeculativeCapture(() => captureContext(true))
    }
  },
  () => (loadConfig().handsFreeMode ? 'tap' : 'hold')
)

// Setup's hotkey test: while it waits, a press only answers the test and starts no turn.
const pressWaiters = new Set<() => void>()
let swallowUp = false

/** Resolves true on the next assistant hotkey press (consumed), false after `ms`. */
export function captureNextHotkey(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (pressed: boolean): void => {
      clearTimeout(timer)
      pressWaiters.delete(onPress)
      resolve(pressed)
    }
    const onPress = (): void => done(true)
    const timer = setTimeout(() => done(false), ms)
    pressWaiters.add(onPress)
  })
}

export function onAssistantHotkeyDown(): void {
  if (pressWaiters.size) {
    swallowUp = true
    for (const w of [...pressWaiters]) w()
    return
  }
  // Key repeat of a captured press.
  if (swallowUp) return
  activation.down()
}

export function onAssistantHotkeyUp(): void {
  if (swallowUp) {
    swallowUp = false
    return
  }
  activation.up()
}

/**
 * A recording ended in the renderer (silence, no speech, error), including wake-word and
 * barge-in recordings the hotkey never started: tray, teach and others see it stop.
 */
export function onRecordingEnded(): void {
  activation.reset()
  bus.emit({ type: 'voice.stopped', ended: true })
}

keepEscapeWhile(() => activation.current !== 'idle')

bus.on('voice.cancelled', () => activation.reset())
bus.on('query.started', () => activation.reset())
