import { useState, useRef, useCallback, useEffect, type MutableRefObject } from 'react'

export interface VoiceResultInfo {
  // Milliseconds of audio above the speech threshold during the recording.
  speechMs: number
}

export interface VoiceStartOptions {
  // Level (RMS, 0..1) that counts as speech when measuring speechMs.
  speechThreshold?: number
  // Hard cap on recording length; the recording is stopped and transcribed when reached.
  maxRecordMs?: number
  // Dictation: transcribed with the dictation prompt (punctuation, personal dictionary).
  dictation?: boolean
  // Safety stop for a recording nobody ended (default 60s).
  watchdogMs?: number
}

interface UseVoiceReturn {
  listening: boolean
  transcript: string
  // Latest RMS input level, updated every animation frame without re-rendering.
  levelRef: MutableRefObject<number>
  start: (opts?: VoiceStartOptions) => Promise<void>
  // Returns false when there was no active session to stop.
  stop: () => boolean
  abort: () => void
  supported: boolean
}

export type VoiceResultHandler = (text: string, info: VoiceResultInfo) => void
export type VoiceErrorHandler = (message: string) => void

const WATCHDOG_MS = 60000
const IDLE_RELEASE_MS = 10000
const DEFAULT_SPEECH_THRESHOLD = 0.04

const SILENCE_HALLUCINATION_RE = /^(thank you( for watching)?|thanks for watching|you|bye)\.?$/i
const MIN_SPEECH_MS = 300

export function computeRms(data: Float32Array): number {
  if (data.length === 0) return 0
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / data.length)
}

export function isSilenceHallucination(text: string): boolean {
  return SILENCE_HALLUCINATION_RE.test(text.trim())
}

// Empty transcripts are always dropped. Known Whisper silence hallucinations are
// dropped only when the recording had almost no speech. Everything else passes,
// including one- and two-word commands.
export function shouldDropTranscript(text: string, speechMs?: number): boolean {
  const t = text.trim()
  if (!t) return true
  if (speechMs === undefined) return false
  return speechMs < MIN_SPEECH_MS && isSilenceHallucination(t)
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

// Stream is opened lazily on the first start(), reused across recordings, and
// released after IDLE_RELEASE_MS without a recording so the OS mic indicator turns off.
let sharedStream: MediaStream | null = null

async function getStream(): Promise<MediaStream> {
  if (sharedStream && sharedStream.getTracks().every((t) => t.readyState === 'live')) {
    return sharedStream
  }
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  return sharedStream
}

function releaseStream(): void {
  sharedStream?.getTracks().forEach((t) => t.stop())
  sharedStream = null
}

interface Session {
  id: number
  stopRequested: boolean
  discarded: boolean
  finished: boolean
  recorder: MediaRecorder | null
  audioCtx: AudioContext | null
  raf: number
  watchdog: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  speechMs: number
}

let sessionSeq = 0

export function useVoice(
  onResult: VoiceResultHandler,
  onError?: VoiceErrorHandler
): UseVoiceReturn {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const levelRef = useRef(0)
  const sessionRef = useRef<Session | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onResultRef = useRef(onResult)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onResultRef.current = onResult
    onErrorRef.current = onError
  })

  const scheduleIdleRelease = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null
      const s = sessionRef.current
      if (s && !s.finished && s.recorder?.state === 'recording') return
      releaseStream()
    }, IDLE_RELEASE_MS)
  }, [])

  const teardownAudio = useCallback((s: Session): void => {
    cancelAnimationFrame(s.raf)
    if (s.audioCtx && s.audioCtx.state !== 'closed') s.audioCtx.close().catch(() => {})
    s.audioCtx = null
    if (s.maxTimer) {
      clearTimeout(s.maxTimer)
      s.maxTimer = null
    }
    if (sessionRef.current === s) levelRef.current = 0
  }, [])

  const finish = useCallback(
    (s: Session) => {
      if (s.finished) return
      s.finished = true
      teardownAudio(s)
      if (s.watchdog) {
        clearTimeout(s.watchdog)
        s.watchdog = null
      }
      if (sessionRef.current === s) {
        setListening(false)
        scheduleIdleRelease()
      }
    },
    [scheduleIdleRelease, teardownAudio]
  )

  const abortSession = useCallback(
    (s: Session | null) => {
      if (!s || s.finished) return
      s.discarded = true
      const rec = s.recorder
      if (rec) {
        rec.ondataavailable = null
        rec.onstop = null
        if (rec.state !== 'inactive') {
          try {
            rec.stop()
          } catch {
            /* already stopped */
          }
        }
      }
      finish(s)
    },
    [finish]
  )

  const start = useCallback(
    async (opts: VoiceStartOptions = {}): Promise<void> => {
      const prev = sessionRef.current
      if (prev && !prev.finished && prev.recorder?.state !== 'inactive') abortSession(prev)
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }

      const s: Session = {
        id: ++sessionSeq,
        stopRequested: false,
        discarded: false,
        finished: false,
        recorder: null,
        audioCtx: null,
        raf: 0,
        watchdog: null,
        maxTimer: null,
        speechMs: 0
      }
      sessionRef.current = s
      levelRef.current = 0
      setListening(true)

      let stream: MediaStream
      try {
        stream = await getStream()
      } catch (err) {
        console.error('[voice] getUserMedia failed:', err)
        if (s.discarded) return
        finish(s)
        onErrorRef.current?.(`Microphone unavailable: ${errorReason(err)}`)
        return
      }

      if (s.discarded) return
      if (s.stopRequested) {
        // Hotkey released before the mic opened: nothing was recorded.
        console.log('[voice] stop requested before recording started')
        finish(s)
        onResultRef.current('', { speechMs: 0 })
        return
      }

      let recorder: MediaRecorder
      try {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
        recorder = new MediaRecorder(stream, { mimeType })
        const chunks: Blob[] = []

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }

        recorder.onstop = async () => {
          teardownAudio(s)
          if (s.discarded) return
          const blob = new Blob(chunks, { type: mimeType })
          const arrayBuffer = await blob.arrayBuffer()
          console.log(
            '[voice] audio captured, size:',
            arrayBuffer.byteLength,
            'bytes, speech ms:',
            Math.round(s.speechMs)
          )
          let text: string
          try {
            text =
              (await window.api.transcribe(
                arrayBuffer,
                opts.dictation ? { dictation: true } : undefined
              )) ?? ''
          } catch (err) {
            console.error('[voice] transcription failed:', err)
            if (s.discarded) return
            finish(s)
            onErrorRef.current?.(`Transcription failed: ${errorReason(err)}`)
            return
          }
          if (s.discarded) return
          console.log('[voice] transcript:', text)
          finish(s)
          setTranscript(text)
          onResultRef.current(text.trim(), { speechMs: s.speechMs })
        }

        s.recorder = recorder
        recorder.start(250)
      } catch (err) {
        console.error('[voice] recorder start failed:', err)
        finish(s)
        onErrorRef.current?.(`Microphone unavailable: ${errorReason(err)}`)
        return
      }
      console.log('[voice] MediaRecorder started')

      s.watchdog = setTimeout(function watchdog() {
        if (s.finished) return
        if (s.recorder?.state === 'recording') {
          console.warn('[voice] watchdog: recording too long, stopping')
          s.recorder.stop()
          s.watchdog = setTimeout(watchdog, WATCHDOG_MS)
          return
        }
        console.warn('[voice] watchdog: transcription stalled, discarding')
        abortSession(s)
        onErrorRef.current?.('Voice request timed out')
      }, opts.watchdogMs ?? WATCHDOG_MS)

      if (opts.maxRecordMs && opts.maxRecordMs > 0) {
        s.maxTimer = setTimeout(() => {
          if (s.recorder?.state === 'recording' && !s.discarded) {
            console.log('[voice] max record duration reached, stopping')
            s.recorder.stop()
          }
        }, opts.maxRecordMs)
      }

      // Analyser set up after the recorder starts so recording is not delayed.
      try {
        const audioCtx = new AudioContext()
        s.audioCtx = audioCtx
        audioCtx.resume().catch(() => {})
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 1024
        audioCtx.createMediaStreamSource(stream).connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        const threshold = opts.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD
        let last = performance.now()

        const tick = (): void => {
          if (s.finished || s.recorder?.state !== 'recording') return
          analyser.getFloatTimeDomainData(data)
          const level = computeRms(data)
          const now = performance.now()
          if (level > threshold) s.speechMs += now - last
          last = now
          if (sessionRef.current === s) levelRef.current = level
          s.raf = requestAnimationFrame(tick)
        }
        tick()
      } catch (err) {
        console.warn('[voice] level analyser unavailable:', err)
      }
    },
    [abortSession, finish, teardownAudio]
  )

  const stop = useCallback((): boolean => {
    const s = sessionRef.current
    if (!s || s.finished || s.discarded) return false
    s.stopRequested = true
    if (s.recorder?.state === 'recording') {
      console.log('[voice] stopping MediaRecorder')
      s.recorder.stop()
    }
    return true
  }, [])

  const abort = useCallback(() => {
    const s = sessionRef.current
    if (!s || s.finished) return
    console.log('[voice] aborting session', s.id)
    abortSession(s)
  }, [abortSession])

  useEffect(
    () => () => {
      abortSession(sessionRef.current)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      releaseStream()
    },
    [abortSession]
  )

  return { listening, transcript, levelRef, start, stop, abort, supported: true }
}
