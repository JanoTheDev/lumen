// Lesson recording (07 T30): "record this lesson" films the lesson's monitor to
// Videos\Lumen\<lesson>-<date>.webm through a hidden recorder window (Chromium MediaRecorder,
// no ffmpeg), plus a markdown transcript beside it. Nothing records without the explicit
// command; a red dot stays on the bar while it runs; it stops on "stop recording the lesson",
// at the lesson's end or stop, after 30 minutes, at 1 GB, or when Lumen quits (the file is
// finalised). Nothing is uploaded. Ports injected; no Electron here.
import { matchVideoCommand } from './grammar'
import { LessonTranscript, type StepEnd } from './transcript'

/** A recording stops by itself after this long. */
export const MAX_VIDEO_MS = 30 * 60_000
/** …or once the file is this big. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
/** The recorder window must report "running" within this long. */
export const START_TIMEOUT_MS = 15_000
/** After a stop request the file is closed at the latest after this long. */
export const STOP_TIMEOUT_MS = 5_000

export const CAPTURE = { fps: 12, maxWidth: 1920, maxHeight: 1080, bitsPerSecond: 2_000_000 }

export interface CaptureConfig {
  sourceId: string
  fps: number
  maxWidth: number
  maxHeight: number
  bitsPerSecond: number
}

export interface LessonInfo {
  title: string
  /** The app's display name ("Blender"). */
  app: string
  /** The step on screen (0-based). */
  index: number
  /** Each step's say line. */
  says: readonly string[]
}

export interface VideoSink {
  write(chunk: Uint8Array): Promise<void>
  /** Closes the file; the bytes written. */
  close(): Promise<number>
  /** Deletes the file (an empty recording). */
  remove(): Promise<void>
}

export interface OpenedFiles {
  sink: VideoSink
  video: string
  transcript: string
}

export interface LessonVideoDeps {
  now(): number
  /** The running lesson, else null. */
  lesson(): LessonInfo | null
  /** How a step went so far (skipped, failed checks, done for the user). */
  stepEnd(index: number): StepEnd | undefined
  /** The screen source of the monitor the lesson's app is on. */
  pickSource(): Promise<{ sourceId: string; name: string } | null>
  /** Creates the free video / transcript pair; the video is open for writing. */
  openFiles(title: string, at: Date): Promise<OpenedFiles | { error: string }>
  writeTranscript(path: string, text: string): Promise<void>
  /** Opens the hidden recorder window; it asks for its config with `begin()`. */
  openRenderer(): void
  /** Asks the recorder window to finish (it sends its last chunk, then "stopped"). */
  requestStop(): void
  closeRenderer(): void
  /** Display capture allowed for the recorder window, Lumen's own windows kept out of it. */
  setCapturing(on: boolean): void
  /** The red dot on the bar. */
  showDot(on: boolean): void
  say(text: string): void
  log(msg: string): void
  handled: unknown
}

export type VideoPhase = 'idle' | 'starting' | 'recording' | 'stopping'

type StopReason = 'user' | 'lesson-done' | 'lesson-stopped' | 'time' | 'size' | 'quit' | 'error'

const STOP_NOTE: Partial<Record<StopReason, string>> = {
  time: 'The lesson recording reached 30 minutes and stopped.',
  size: 'The lesson recording got too big and stopped.'
}

export interface LessonVideo {
  phase(): VideoPhase
  /** The dot is up: a recording is running or finishing. */
  active(): boolean
  start(): Promise<{ ok: boolean; error?: string }>
  stop(reason?: StopReason): Promise<void>
  /** The recorder window's config, only while a recording is starting. */
  begin(): CaptureConfig | null
  chunk(bytes: Uint8Array): void
  status(s: { state: 'running' | 'stopped' | 'error'; error?: string }): void
  stepStarted(index: number): void
  stepPassed(index: number): void
  lessonDone(completed: boolean): void
  /** Voice words while a lesson runs; undefined when not ours. */
  intercept(utterance: string): unknown | undefined
}

export function createLessonVideo(deps: LessonVideoDeps): LessonVideo {
  let phase: VideoPhase = 'idle'
  let source: { sourceId: string; name: string } | null = null
  let files: OpenedFiles | null = null
  let transcript: LessonTranscript | null = null
  let title = ''
  let app = ''
  let writes: Promise<void> = Promise.resolve()
  let bytes = 0
  let writeFailed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let finishing: Promise<void> | null = null
  let lessonEnd: boolean | null = null
  let stopReason: StopReason = 'user'
  const stopWaiters: Array<() => void> = []

  function arm(ms: number, fn: () => void): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
    timer.unref?.()
  }

  function disarm(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function reset(): void {
    disarm()
    phase = 'idle'
    source = files = transcript = null
    writes = Promise.resolve()
    bytes = 0
    writeFailed = false
    finishing = null
    lessonEnd = null
    stopReason = 'user'
  }

  /** Closes everything; the file is kept when it has data, the transcript written beside it. */
  function finish(reason: StopReason, error?: string): Promise<void> {
    if (finishing) return finishing
    stopReason = reason
    const wasRecording = phase === 'recording' || phase === 'stopping'
    phase = 'stopping'
    disarm()
    deps.closeRenderer()
    deps.setCapturing(false)
    deps.showDot(false)
    const f = files
    const t = transcript
    finishing = (async () => {
      await writes.catch(() => {})
      const size = f ? await f.sink.close().catch(() => 0) : 0
      if (f && (size === 0 || !wasRecording)) {
        await f.sink.remove().catch(() => {})
        deps.log(`lesson video: nothing recorded${error ? ` (${error})` : ''}`)
        if (reason !== 'quit')
          deps.say(`The lesson recording did not work${error ? `: ${error}` : '.'}`)
        return
      }
      if (f && t) {
        const last = t.openIndex()
        t.end(deps.now(), lessonEnd, last === null ? undefined : deps.stepEnd(last))
        await deps.writeTranscript(f.transcript, t.render()).catch((e: Error) => {
          deps.log(`lesson video: transcript not written (${e.message})`)
        })
      }
      deps.log(`lesson video: saved ${Math.round(size / 1024)} KB (${reason})`)
      if (reason === 'quit') return
      const note = STOP_NOTE[reason] ?? (error ? `The lesson recording stopped: ${error}.` : '')
      deps.say(
        `${note ? `${note} ` : ''}Saved the lesson video and its transcript in Videos, Lumen.`
      )
    })().finally(() => {
      reset()
      for (const w of stopWaiters.splice(0)) w()
    })
    return finishing
  }

  const api: LessonVideo = {
    phase: () => phase,
    active: () => phase === 'recording' || phase === 'stopping',

    async start() {
      if (phase !== 'idle') return { ok: false, error: 'a lesson recording is already running' }
      const lesson = deps.lesson()
      if (!lesson) return { ok: false, error: 'no lesson is running' }
      phase = 'starting'
      title = lesson.title
      app = lesson.app
      const src = await deps.pickSource().catch(() => null)
      if (!src || phase !== 'starting') {
        reset()
        return { ok: false, error: 'I could not find the screen to record' }
      }
      const opened = await deps
        .openFiles(title, new Date(deps.now()))
        .catch((e: Error) => ({ error: e.message }))
      if ('error' in opened) {
        reset()
        return { ok: false, error: opened.error }
      }
      if (phase !== 'starting') {
        // Stopped while the file was being made.
        await opened.sink.close().catch(() => 0)
        await opened.sink.remove().catch(() => {})
        return { ok: false, error: 'the recording was stopped' }
      }
      source = src
      files = opened
      deps.setCapturing(true)
      deps.openRenderer()
      arm(START_TIMEOUT_MS, () => void finish('error', 'the screen capture did not start'))
      deps.log(`lesson video: starting on ${src.name}`)
      return { ok: true }
    },

    stop(reason = 'user') {
      if (phase === 'idle') return Promise.resolve()
      if (finishing) return finishing
      if (phase === 'starting') return finish(reason)
      const waited = new Promise<void>((r) => stopWaiters.push(r))
      if (phase === 'recording') {
        stopReason = reason
        phase = 'stopping'
        deps.requestStop()
        arm(STOP_TIMEOUT_MS, () => void finish(stopReason))
      }
      return waited
    },

    begin() {
      if (phase !== 'starting' || !source) return null
      return { sourceId: source.sourceId, ...CAPTURE }
    },

    chunk(data) {
      if (!files || (phase !== 'recording' && phase !== 'stopping') || finishing) return
      if (!data.byteLength) return
      bytes += data.byteLength
      const sink = files.sink
      writes = writes.then(() =>
        writeFailed
          ? undefined
          : sink.write(data).catch((e: Error) => {
              writeFailed = true
              deps.log(`lesson video: write failed (${e.message})`)
              void finish('error', 'the file could not be written')
            })
      )
      if (bytes >= MAX_VIDEO_BYTES && phase === 'recording') void api.stop('size')
    },

    status(s) {
      if (s.state === 'running') {
        if (phase !== 'starting') return
        phase = 'recording'
        const lesson = deps.lesson()
        const now = deps.now()
        transcript = new LessonTranscript(title, app, new Date(now), now)
        if (lesson) transcript.stepStarted(lesson.index, lesson.says[lesson.index] ?? '', now)
        arm(MAX_VIDEO_MS, () => void api.stop('time'))
        deps.showDot(true)
        deps.log('lesson video: recording')
        deps.say(
          'Recording this lesson to your Videos folder. Say “stop recording the lesson” to stop.'
        )
        return
      }
      if (s.state === 'stopped') {
        if (phase === 'stopping' || phase === 'recording') void finish(stopReason)
        return
      }
      if (phase !== 'idle') void finish('error', s.error || 'the screen capture failed')
    },

    stepStarted(index) {
      const lesson = deps.lesson()
      if (!transcript || !lesson || phase !== 'recording') return
      const open = transcript.openIndex()
      transcript.stepStarted(
        index,
        lesson.says[index] ?? '',
        deps.now(),
        open === null ? undefined : deps.stepEnd(open)
      )
    },

    stepPassed(index) {
      if (transcript && phase === 'recording') transcript.stepPassed(index, deps.stepEnd(index))
    },

    lessonDone(completed) {
      if (phase === 'idle') return
      lessonEnd = completed
      void api.stop(completed ? 'lesson-done' : 'lesson-stopped')
    },

    intercept(utterance) {
      const cmd = matchVideoCommand(utterance, phase !== 'idle')
      if (!cmd) return undefined
      if (cmd === 'start') {
        if (phase !== 'idle')
          return { mode: 'answer', text: 'This lesson is already being recorded.' }
        return api
          .start()
          .then((r) =>
            r.ok
              ? deps.handled
              : { mode: 'answer', text: `I could not record the lesson: ${r.error}.` }
          )
      }
      if (phase === 'idle') return { mode: 'answer', text: 'No lesson recording is running.' }
      void api.stop('user')
      return deps.handled
    }
  }

  return api
}
