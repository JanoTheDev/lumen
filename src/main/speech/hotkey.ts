// Wires the assistant hotkey gestures (speech/activation.ts) to the voice renderer and status.
import { bus } from '../bus'
import { loadConfig } from '../config'
import { holdEscape, keepEscapeWhile } from '../agent/escape'
import { startSpeculativeCapture } from '../query/context'
import { captureContext } from '../query/capture'
import * as assistant from '../windows/assistant'
import { AssistantActivation, realTimers } from './activation'
import { Conversation } from './conversation'
import { voiceLatency } from './latency'

let recordingOpen = false

const conversation = new Conversation(
  {
    listen() {
      holdEscape('hud')
      bus.emit({ type: 'voice.started', handsFree: true })
      assistant.setStatus('listening', 'Listening… (conversation)')
    },
    recording: () => recordingOpen || activation.current !== 'idle',
    cancel() {
      bus.emit({ type: 'voice.cancelled' })
    },
    status(text) {
      console.log(`[voice] conversation ${text ? 'on' : 'off'}`)
      if (text) assistant.setStatus('listening', text)
    }
  },
  realTimers
)

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
      voiceLatency.speechEnded()
      bus.emit({ type: 'voice.stopped' })
      assistant.setStatus('transcribing', 'Transcribing', { index: 1, total: 3 })
      // Capture while speech is transcribed; runQuery awaits this promise if it is fresh.
      startSpeculativeCapture(() => captureContext(true))
    },
    doubleTap() {
      return conversation.toggle()
    }
  },
  () => (loadConfig().handsFreeMode ? 'tap' : 'hold'),
  realTimers,
  () => loadConfig().voice.conversation
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
  voiceLatency.speechEnded()
  activation.reset()
  bus.emit({ type: 'voice.stopped', ended: true })
}

keepEscapeWhile(() => activation.current !== 'idle' || conversation.active)

/** The voice renderer finished a turn (`assistant:close`): a conversation listens again. */
export function onTurnEnded(): void {
  conversation.turnEnded()
}

/** Spoken reply started or stopped in the voice renderer. */
export function onSpeakingChanged(speaking: boolean): void {
  conversation.setSpeaking(speaking)
}

export function conversationActive(): boolean {
  return conversation.active
}

bus.on('voice.started', () => {
  recordingOpen = true
})
bus.on('voice.stopped', () => {
  recordingOpen = false
})
bus.on('voice.cancelled', () => {
  recordingOpen = false
  activation.reset()
  conversation.end()
})
bus.on('dictation.started', () => conversation.end())
bus.on('query.started', () => {
  activation.reset()
  conversation.touch()
})
