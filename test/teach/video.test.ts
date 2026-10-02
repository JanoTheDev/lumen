import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { matchVideoCommand } from '../../src/main/teach/video/grammar'
import { videoPaths, videoStem } from '../../src/main/teach/video/naming'
import { LessonTranscript, clock } from '../../src/main/teach/video/transcript'
import {
  MAX_VIDEO_BYTES,
  MAX_VIDEO_MS,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  createLessonVideo,
  type LessonInfo,
  type LessonVideo,
  type LessonVideoDeps
} from '../../src/main/teach/video/session'
import type { StepEnd } from '../../src/main/teach/video/transcript'

describe('lesson video grammar', () => {
  it('starts on explicit lesson words only', () => {
    for (const u of [
      'record this lesson',
      'Record the lesson.',
      'start recording the lesson',
      'make a video of this lesson',
      'record a video of the lesson'
    ])
      expect(matchVideoCommand(u, false)).toBe('start')
    for (const u of ['record', 'record my steps', 'watch me do this', 'next', 'start'])
      expect(matchVideoCommand(u, false)).toBeNull()
  })

  it('stops on lesson words, and on plain "stop recording" only while recording', () => {
    expect(matchVideoCommand('stop recording the lesson', false)).toBe('stop')
    expect(matchVideoCommand('end the lesson recording', false)).toBe('stop')
    expect(matchVideoCommand('stop recording', false)).toBeNull()
    expect(matchVideoCommand('stop recording', true)).toBe('stop')
    expect(matchVideoCommand('stop the video', true)).toBe('stop')
    expect(matchVideoCommand('stop', true)).toBeNull()
    expect(matchVideoCommand('stop the lesson', true)).toBeNull()
  })
})

describe('lesson video file names', () => {
  const at = new Date(2026, 9, 2, 14, 5)

  it('names the pair after the lesson and the local date, Windows-safe', () => {
    expect(videoStem('Add an object', at)).toBe('Add an object-2026-10-02')
    expect(videoStem('a/b: c?', at)).toBe('a b c-2026-10-02')
    expect(videoStem('CON', at)).toBe('Lesson-2026-10-02')
    const p = videoPaths('C:\\Users\\me\\Videos', 'Add an object', at, () => false)
    expect(p).toEqual({
      video: join('C:\\Users\\me\\Videos', 'Lumen', 'Add an object-2026-10-02.webm'),
      transcript: join('C:\\Users\\me\\Videos', 'Lumen', 'Add an object-2026-10-02.md')
    })
  })

  it('never overwrites: the next free pair, also when only the transcript exists', () => {
    const dir = join('C:\\v', 'Lumen')
    const taken = new Set([
      join(dir, 'L-2026-10-02.webm'),
      join(dir, 'L (2)-2026-10-02.md'),
      join(dir, 'L-2026-10-02 (2).md')
    ])
    const p = videoPaths('C:\\v', 'L', at, (f) => taken.has(f))
    expect(p?.video).toBe(join(dir, 'L-2026-10-02 (3).webm'))
    expect(p?.transcript).toBe(join(dir, 'L-2026-10-02 (3).md'))
    expect(videoPaths('C:\\v', 'L', at, () => true)).toBeNull()
  })
})

describe('lesson video transcript', () => {
  it('lists steps with relative times and outcomes', () => {
    const t = new LessonTranscript('Add an object', 'Blender', new Date(2026, 9, 2, 9, 30), 1000)
    t.stepStarted(0, 'Press Shift A.', 1000)
    t.stepPassed(0, { attempts: 1 })
    t.stepStarted(1, 'Pick Mesh,\nthen Cube.', 16_000)
    t.stepStarted(1, 'Pick Mesh, then Cube.', 17_000) // resumed: same row
    t.stepStarted(2, 'Move it.', 76_000, { skipped: true })
    t.stepStarted(3, 'Scale it.', 90_000)
    t.end(95_000, false, { attempts: 2, doItForMe: true })
    const md = t.render()
    expect(md).toContain('# Add an object')
    expect(md).toContain('Lesson recording, Blender, 2026-10-02 09:30.')
    expect(md).toContain('- **00:00** Step 1: Press Shift A. — passed (1 try before)')
    expect(md).toContain('- **00:15** Step 2: Pick Mesh, then Cube. — skipped')
    expect(md).toContain('- **01:15** Step 3: Move it. — not passed')
    expect(md).toContain('Step 4: Scale it. — not passed (2 tries before, done by Lumen)')
    expect(md).toContain('Lesson stopped at 01:34.')
    expect(md).toContain('Passed 1, not passed 2, skipped 1.')
  })

  it('leaves the open step open when only the video stopped', () => {
    const t = new LessonTranscript('L', '', new Date(2026, 0, 1), 0)
    t.stepStarted(0, 'One.', 0)
    t.end(5000, null)
    expect(t.render()).toContain('still on this step when the recording ended')
    expect(t.render()).toContain('Recording stopped at 00:05.')
  })

  it('formats clock times', () => {
    expect(clock(75_000)).toBe('01:15')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(-5)).toBe('00:00')
  })
})

describe('lesson video state machine', () => {
  let now = 0
  let lesson: LessonInfo | null
  let deps: LessonVideoDeps
  let written: Uint8Array[]
  let removed: number
  let transcripts: Array<{ path: string; text: string }>
  let said: string[]
  let calls: string[]
  const stats: Record<number, StepEnd> = {}

  beforeEach(() => {
    vi.useFakeTimers()
    now = 10_000
    lesson = { title: 'Add an object', app: 'Blender', index: 0, says: ['One.', 'Two.', 'Three.'] }
    written = []
    removed = 0
    transcripts = []
    said = []
    calls = []
    for (const k of Object.keys(stats)) delete stats[Number(k)]
    deps = {
      now: () => now,
      lesson: () => lesson,
      stepEnd: (i) => stats[i],
      pickSource: async () => ({ sourceId: 'screen:1:0', name: 'Screen 1' }),
      openFiles: async () => ({
        video: 'v.webm',
        transcript: 'v.md',
        sink: {
          write: async (c) => void written.push(c),
          close: async () => written.reduce((n, c) => n + c.byteLength, 0),
          remove: async () => void removed++
        }
      }),
      writeTranscript: async (path, text) => void transcripts.push({ path, text }),
      openRenderer: () => calls.push('open'),
      requestStop: () => calls.push('request-stop'),
      closeRenderer: () => calls.push('close'),
      setCapturing: (on) => calls.push(`capture:${on}`),
      showDot: (on) => calls.push(`dot:${on}`),
      say: (t) => said.push(t),
      log: () => {},
      handled: 'HANDLED'
    }
  })

  afterEach(() => vi.useRealTimers())

  async function recording(): Promise<LessonVideo> {
    const v = createLessonVideo(deps)
    expect(await v.start()).toEqual({ ok: true })
    expect(v.begin()).toMatchObject({ sourceId: 'screen:1:0', fps: 12 })
    v.status({ state: 'running' })
    return v
  }

  it('refuses without a lesson and gives no capture config while idle', async () => {
    lesson = null
    const v = createLessonVideo(deps)
    expect(await v.start()).toEqual({ ok: false, error: 'no lesson is running' })
    expect(v.begin()).toBeNull()
    expect(calls).toEqual([])
  })

  it('records, shows the dot, and finalises with a transcript on the stop words', async () => {
    const v = await recording()
    expect(calls).toEqual(['capture:true', 'open', 'dot:true'])
    expect(v.active()).toBe(true)
    v.chunk(new Uint8Array([1, 2]))
    now += 4000
    lesson!.index = 1
    v.stepPassed(0)
    v.stepStarted(1)
    expect(v.intercept('stop recording')).toBe('HANDLED')
    expect(calls).toContain('request-stop')
    v.chunk(new Uint8Array([3]))
    v.status({ state: 'stopped' })
    await vi.runAllTimersAsync()
    expect(written.map((c) => [...c])).toEqual([[1, 2], [3]])
    expect(calls.slice(-3)).toEqual(['close', 'capture:false', 'dot:false'])
    expect(transcripts[0].path).toBe('v.md')
    expect(transcripts[0].text).toContain('Step 1: One. — passed')
    expect(transcripts[0].text).toContain('- **00:04** Step 2: Two.')
    expect(said.at(-1)).toContain('Saved the lesson video')
    expect(v.phase()).toBe('idle')
    expect(v.begin()).toBeNull()
  })

  it('stops with the lesson and records how it ended', async () => {
    const v = await recording()
    v.chunk(new Uint8Array([1]))
    v.lessonDone(true)
    v.status({ state: 'stopped' })
    await vi.runAllTimersAsync()
    expect(transcripts[0].text).toContain('Lesson finished')
  })

  it('closes the file after a stop timeout when the recorder never answers', async () => {
    const v = await recording()
    v.chunk(new Uint8Array([1]))
    const stopped = v.stop()
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS)
    await stopped
    expect(v.phase()).toBe('idle')
    expect(transcripts).toHaveLength(1)
  })

  it('stops at the 30 minute cap and at the size cap', async () => {
    const v = await recording()
    v.chunk(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(MAX_VIDEO_MS)
    expect(calls).toContain('request-stop')
    v.status({ state: 'stopped' })
    await vi.runAllTimersAsync()
    expect(said.at(-1)).toContain('30 minutes')

    calls = []
    const w = await recording()
    w.chunk({ byteLength: MAX_VIDEO_BYTES } as Uint8Array)
    expect(calls).toContain('request-stop')
  })

  it('deletes an empty file and says so; a capture that never starts times out', async () => {
    const v = createLessonVideo(deps)
    await v.start()
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    expect(removed).toBe(1)
    expect(said.at(-1)).toContain('did not work')
    expect(calls).toContain('capture:false')
    expect(v.phase()).toBe('idle')

    const w = await recording()
    w.status({ state: 'error', error: 'Permission denied' })
    await vi.runAllTimersAsync()
    expect(removed).toBe(2)
    expect(said.at(-1)).toContain('Permission denied')
  })

  it('answers start and stop words in the wrong state', async () => {
    const v = createLessonVideo(deps)
    expect(v.intercept('stop recording the lesson')).toEqual({
      mode: 'answer',
      text: 'No lesson recording is running.'
    })
    expect(v.intercept('stop recording')).toBeUndefined()
    expect(await v.intercept('record this lesson')).toBe('HANDLED')
    expect(v.intercept('record this lesson')).toMatchObject({ mode: 'answer' })
    expect(v.intercept('next')).toBeUndefined()
  })

  it('finalises quietly on quit', async () => {
    const v = await recording()
    said = []
    v.chunk(new Uint8Array([1]))
    const done = v.stop('quit')
    v.status({ state: 'stopped' })
    await done
    expect(transcripts).toHaveLength(1)
    expect(said).toEqual([])
  })
})
