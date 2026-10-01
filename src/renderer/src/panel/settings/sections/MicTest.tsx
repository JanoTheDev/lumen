// Live level meter for a microphone (Settings → Voice and onboarding).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, announce, icons } from '../../../ui'
import { micConstraints } from '../../../voice/mic'
import { meterLevel } from './voice-options'

const TEST_MS = 15_000
const HEARD_LEVEL = 0.45

function micError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError')
    return 'The microphone is blocked. Allow microphone access in Windows privacy settings.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'That microphone isn’t connected.'
  return 'Couldn’t open the microphone.'
}

/** Live level meter for the chosen microphone; stops by itself after 15 s. */
export function MicTest({
  deviceId,
  onOpened
}: {
  deviceId: string
  onOpened: () => void
}): JSX.Element {
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState('')
  const fill = useRef<HTMLDivElement>(null)
  const stopRef = useRef<(() => void) | null>(null)
  // Bumped by every stop (and unmount): a start still waiting for the mic is then stale.
  const genRef = useRef(0)

  const stop = useCallback((): void => {
    genRef.current++
    stopRef.current?.()
    stopRef.current = null
  }, [])

  // Picking another device or leaving the page ends the test.
  useEffect(() => stop, [deviceId, stop])

  const start = async (): Promise<void> => {
    stop()
    const gen = genRef.current
    setMessage('Say something…')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
    } catch (err) {
      if (gen !== genRef.current) return
      const text = micError(err)
      setMessage(text)
      announce(text, 'assertive')
      return
    }
    if (gen !== genRef.current) {
      // Stopped, restarted or unmounted while the mic opened: let this stream go.
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    onOpened()
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let level = 0
    let heard = false
    let raf = 0
    const tick = (): void => {
      analyser.getFloatTimeDomainData(buf)
      level = Math.max(meterLevel(buf), level * 0.85)
      if (fill.current) fill.current.style.transform = `scaleX(${level})`
      if (!heard && level >= HEARD_LEVEL) {
        heard = true
        setMessage('Lumen hears you.')
        announce('Lumen hears you.')
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const timer = setTimeout(() => {
      stop()
      if (!heard) {
        const text = 'Lumen didn’t hear anything. Check the microphone or pick another one.'
        setMessage(text)
        announce(text, 'assertive')
      }
    }, TEST_MS)
    stopRef.current = () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => {})
      if (fill.current) fill.current.style.transform = 'scaleX(0)'
      setRunning(false)
    }
    setRunning(true)
  }

  return (
    <div className="panel-mic-test">
      <div className="panel-row">
        <Button
          icon={running ? icons.square : icons.mic}
          onClick={() => (running ? stop() : void start())}
        >
          {running ? 'Stop test' : 'Test microphone'}
        </Button>
        <span className="ui-hint" aria-live="polite">
          {message}
        </span>
      </div>
      <div className="panel-meter" aria-hidden="true">
        <div ref={fill} className="panel-meter__fill" />
      </div>
    </div>
  )
}
