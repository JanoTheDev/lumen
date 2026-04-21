import { useState, useRef, useCallback, useEffect } from 'react'

interface UseVoiceReturn {
  listening: boolean
  transcript: string
  audioLevel: number
  start: () => void
  stop: () => void
  supported: boolean
}

// Cached stream — pre-warmed on mount, reused across recordings
let sharedStream: MediaStream | null = null

async function getStream(): Promise<MediaStream> {
  if (sharedStream && sharedStream.getTracks().every((t) => t.readyState === 'live')) {
    return sharedStream
  }
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  return sharedStream
}

export function useVoice(onResult: (text: string) => void, onError?: (err: unknown) => void): UseVoiceReturn {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [audioLevel, setAudioLevel] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const animFrameRef = useRef<number>(0)

  // Pre-warm mic permission on mount so first recording has no delay
  useEffect(() => {
    getStream().catch(() => {})
  }, [])

  const start = useCallback(async () => {
    try {
      const stream = await getStream()

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        cancelAnimationFrame(animFrameRef.current)
        audioCtx.close().catch(() => {})
        setAudioLevel(0)
        // don't stop stream tracks — keep stream alive for next recording

        const blob = new Blob(chunksRef.current, { type: mimeType })
        const arrayBuffer = await blob.arrayBuffer()
        console.log('[voice] audio captured, size:', arrayBuffer.byteLength, 'bytes')

        try {
          const text = await window.api.transcribe(arrayBuffer)
          console.log('[voice] transcript:', text)
          setTranscript(text ?? '')
          onResult(text?.trim() ?? '')
        } catch (err) {
          console.error('[voice] transcription failed:', err)
          onError?.(err)
        }
        setListening(false)
      }

      recorderRef.current = recorder
      recorder.start(250)
      setListening(true)
      console.log('[voice] MediaRecorder started')

      // Set up audio analyser AFTER starting recorder so recording isn't delayed
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {})
      }
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      audioCtx.resume().catch(() => {})

      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)

      const tick = (): void => {
        analyser.getByteFrequencyData(data)
        const level = data.reduce((s, v) => s + v, 0) / data.length / 255
        setAudioLevel(level)
        animFrameRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch (err) {
      console.error('[voice] start failed:', err)
      setListening(false)
    }
  }, [onResult])

  const stop = useCallback(() => {
    console.log('[voice] stopping MediaRecorder')
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [])

  return { listening, transcript, audioLevel, start, stop, supported: true }
}
