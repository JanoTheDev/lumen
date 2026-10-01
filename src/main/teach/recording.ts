// Record my steps (plans 07 T31): "watch me do this" starts an explicit recording of the
// user's clicks, selections, fields and shortcuts (agent uia-event / key-combo / focus events);
// "stop recording" turns it into a lesson draft (recorder.ts skeleton, fast model for the
// words); the user reviews it by voice ("read it back", "try it", "save it as …", "discard
// it") or in Settings → Lessons, and it is saved as a user lesson. A red-dot line stays in the
// bar the whole time a recording runs. Deps injected; no Electron.
import type { LessonDraftEdit, RecordingStatus } from '@shared/channels'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { matchDraftCommand, matchRecordingCommand, matchRecordStart } from './commands'
import { parseLesson, toStoredLesson, type Lesson } from './lesson'
import type { DraftText } from './recorder'
import {
  Recording,
  draftLesson,
  editDraft,
  mainApp,
  skeleton,
  waitsFor,
  type RawUiaEvent,
  type RecordedApp,
  type SkeletonStep
} from './recorder'
import type { RecordTurnInput } from './record-prompt'
import { freeLessonId, writeUserLesson } from './user-lessons'

/** A recording stops by itself after this long. */
export const MAX_RECORDING_MS = 10 * 60_000
const FOREGROUND_POLL_MS = 1000
/** Voice review ("save it", "try it") is answerable this long after the draft is ready. */
const VOICE_REVIEW_MS = 10 * 60_000

type Image = { data: string; mime: string }

export interface RecordingDeps {
  now(): number
  /** The app in front, mapped to a pack or a process name. */
  foreground(): Promise<RecordedApp | null>
  /** Starts the agent's event streams for the recording; returns the stop function. */
  subscribe(on: { uia(e: RawUiaEvent): void; key(combo: string): void }): () => void
  /** A screenshot of the foreground monitor, only when the user asks for one. */
  capture(): Promise<Image | null>
  /** The fast model writes the words; null when it fails (plain lines are used then). */
  draftText(input: RecordTurnInput, images: Image[]): Promise<DraftText | null>
  hotkey(): string | undefined
  /** The bar line while recording / drafting; null hands the bar back. */
  showState(text: string | null): void
  /** A passive bar line. */
  showLine(text: string): void
  say(text: string): void
  lessonsDir(): string
  /** Where the draft waits for review (~/.ai-overlay/teach/draft.lesson.json). */
  draftFile(): string
  /** Re-reads the lessons after a save. */
  reload(): void
  /** Plays the draft once without saving it. */
  play(lesson: Lesson): boolean
  lessonRunning(): boolean
  /** "windows" → "Windows 11". */
  appName(id: string): string
  log(msg: string): void
  handled: unknown
  /** Skill output mode (11 T11): the recorded steps become a skill draft instead of a lesson. */
  skillOut?(input: { app: RecordedApp; title?: string; steps: SkeletonStep[] }): Promise<void>
}

/** What a recording turns into: a lesson (07 T31) or a skill draft (11 T11). */
export type RecordingOutput = 'lesson' | 'skill'

export interface Recorder {
  start(title?: string, output?: RecordingOutput): { ok: boolean; error?: string }
  stop(): Promise<{ ok: boolean; error?: string }>
  cancel(): { ok: boolean }
  /** The user is talking to Lumen: nothing is recorded meanwhile. */
  hold(on: boolean): void
  status(): RecordingStatus
  save(edit?: LessonDraftEdit | { name?: string }): Lesson | { error: string }
  discard(): boolean
  playDraft(): boolean
  intercept(utterance: string): unknown | undefined
  recording(): boolean
  /** A lesson made elsewhere (a tutorial import, 11 T12) becomes the draft to review. */
  offerDraft(lesson: Lesson, note?: string): { ok: boolean; error?: string }
}

export function createRecorder(deps: RecordingDeps): Recorder {
  let phase: RecordingStatus['phase'] = 'idle'
  let rec: Recording | null = null
  let unsubscribe: (() => void) | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let limit: ReturnType<typeof setTimeout> | null = null
  let app: RecordedApp | null = null
  let output: RecordingOutput = 'lesson'
  let draft: Lesson | null = loadDraft()
  let draftAt = 0
  if (draft) phase = 'draft'

  function loadDraft(): Lesson | null {
    try {
      const file = deps.draftFile()
      return existsSync(file) ? parseLesson(JSON.parse(readFileSync(file, 'utf8'))) : null
    } catch {
      return null
    }
  }

  function writeDraft(lesson: Lesson | null): void {
    const file = deps.draftFile()
    try {
      if (!lesson) {
        rmSync(file, { force: true })
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, `${JSON.stringify(toStoredLesson(lesson), null, 2)}\n`, 'utf8')
      renameSync(`${file}.tmp`, file)
    } catch (e) {
      deps.log(`record: draft not written (${(e as Error).message})`)
    }
  }

  const barLine = (): string => {
    const n = rec?.events.length ?? 0
    const what = output === 'skill' ? 'your steps for a skill' : 'your steps'
    return `● Recording ${what} (${n} so far). Say “stop recording” when you are done.`
  }

  function stopWatching(): void {
    unsubscribe?.()
    unsubscribe = null
    if (poll) clearInterval(poll)
    if (limit) clearTimeout(limit)
    poll = limit = null
  }

  function refreshApp(): void {
    void deps
      .foreground()
      .then((a) => {
        if (a) app = a
      })
      .catch(() => {})
  }

  function onEvent(accepted: boolean): void {
    if (!rec || !accepted) return
    deps.showState(barLine())
    if (rec.full()) void api.stop()
  }

  function draftSummary(l: Lesson): string {
    return `Draft ready: “${l.title}”, ${l.steps.length} ${l.steps.length === 1 ? 'step' : 'steps'}. Say “read it back”, “try it”, “save it as” and a name, or “discard it”. You can also edit it in Settings, Lessons.`
  }

  function readBack(l: Lesson): string {
    return `${l.title}. ${l.steps.map((s, i) => `Step ${i + 1}: ${s.say}`).join(' ')}`
  }

  const api: Recorder = {
    recording: () => phase === 'recording',

    start(title, mode = 'lesson') {
      if (phase === 'recording' || phase === 'drafting')
        return { ok: false, error: 'already recording' }
      if (deps.lessonRunning()) return { ok: false, error: 'stop the lesson first' }
      if (mode === 'skill' && !deps.skillOut) return { ok: false, error: 'skills are not ready' }
      output = mode
      const replaced = !!draft && mode === 'lesson'
      rec = new Recording(deps.now(), { hotkey: deps.hotkey(), title })
      phase = 'recording'
      app = null
      refreshApp()
      poll = setInterval(refreshApp, FOREGROUND_POLL_MS)
      poll.unref?.()
      limit = setTimeout(() => void api.stop(), MAX_RECORDING_MS)
      limit.unref?.()
      unsubscribe = deps.subscribe({
        uia: (e) => onEvent(!!rec?.uia(e, deps.now(), app ?? undefined)),
        key: (c) => onEvent(!!rec?.key(c, deps.now(), app ?? undefined))
      })
      deps.log(
        `record: started${title ? ` (“${title}”)` : ''}; watching clicks, fields and shortcuts, no typing, no screenshots`
      )
      deps.showState(barLine())
      deps.say(
        mode === 'skill'
          ? 'Recording your steps for a new skill. Do the task now, then say “stop recording”. What you type is not recorded; the skill asks for it each time it runs.'
          : `Recording your steps${replaced ? ', this replaces the unsaved draft' : ''}. Do the task now, then say “stop recording”. What you type is not recorded. Say “take a screenshot” to add a picture of a step.`
      )
      return { ok: true }
    },

    async stop() {
      if (phase !== 'recording' || !rec) return { ok: false, error: 'not recording' }
      const r = rec
      rec = null
      stopWatching()
      phase = 'drafting'
      const steps = skeleton(r.events)
      deps.log(`record: stopped, ${r.events.length} events, ${steps.length} steps`)
      if (!steps.length) {
        phase = draft ? 'draft' : 'idle'
        deps.showState(null)
        deps.say('I did not see any steps, so there is nothing to save.')
        return { ok: false, error: 'no steps recorded' }
      }
      const lessonApp = mainApp(steps) ?? app ?? { id: 'desktop', name: 'Windows' }
      if (output === 'skill' && deps.skillOut) {
        deps.showState('Writing the skill from your steps…')
        await deps
          .skillOut({ app: lessonApp, title: r.title, steps })
          .catch((e: Error) => deps.log(`record: skill draft failed (${e.message})`))
        deps.showState(null)
        phase = draft ? 'draft' : 'idle'
        return { ok: true }
      }
      deps.showState('Writing the lesson from your steps…')
      const minutes = Math.max(1, Math.round((deps.now() - r.startedAt) / 60_000))
      const text = await deps
        .draftText({ app: lessonApp, title: r.title, steps, shots: r.shots.length }, r.shots)
        .catch((e: Error) => {
          deps.log(`record: draft text failed (${e.message}); plain lines used`)
          return null
        })
      const lesson = draftLesson(steps, text, { app: lessonApp, title: r.title, minutes })
      deps.showState(null)
      if (!lesson) {
        phase = draft ? 'draft' : 'idle'
        deps.say('I could not make a lesson from those steps.')
        return { ok: false, error: 'no lesson' }
      }
      draft = lesson
      draftAt = deps.now()
      phase = 'draft'
      writeDraft(lesson)
      const line = draftSummary(lesson)
      deps.showLine(line)
      deps.say(line)
      return { ok: true }
    },

    cancel() {
      if (phase !== 'recording') return { ok: false }
      rec = null
      stopWatching()
      phase = draft ? 'draft' : 'idle'
      deps.showState(null)
      deps.say('Recording cancelled. Nothing was kept.')
      deps.log('record: cancelled')
      return { ok: true }
    },

    hold(on) {
      rec?.hold(on)
    },

    status() {
      return {
        phase,
        events: rec?.events.length ?? 0,
        draft: draft
          ? {
              title: draft.title,
              appId: draft.app,
              appName: deps.appName(draft.app),
              steps: draft.steps.map((s) => ({ id: s.id, say: s.say, waitsFor: waitsFor(s.check) }))
            }
          : null
      }
    },

    save(edit) {
      if (!draft) return { error: 'there is no draft to save' }
      let lesson: Lesson | null = draft
      if (edit && 'steps' in edit) lesson = editDraft(draft, edit)
      else if (edit && 'name' in edit && edit.name)
        lesson = { ...draft, title: edit.name.slice(0, 80) }
      if (!lesson) return { error: 'the lesson needs at least one step' }
      const dir = deps.lessonsDir()
      const saved: Lesson = { ...lesson, id: freeLessonId(dir, lesson.app, lesson.title) }
      try {
        writeUserLesson(dir, saved)
      } catch (e) {
        deps.log(`record: saving failed (${(e as Error).message})`)
        return { error: 'the lesson could not be saved' }
      }
      draft = null
      phase = 'idle'
      writeDraft(null)
      deps.reload()
      deps.log(`record: saved “${saved.title}” as ${saved.id}`)
      return saved
    },

    discard() {
      if (!draft) return false
      draft = null
      if (phase === 'draft') phase = 'idle'
      writeDraft(null)
      deps.log('record: draft discarded')
      return true
    },

    playDraft() {
      return !!draft && phase !== 'recording' && deps.play(draft)
    },

    offerDraft(lesson, note) {
      if (phase === 'recording' || phase === 'drafting')
        return { ok: false, error: 'a recording is running' }
      draft = lesson
      draftAt = deps.now()
      phase = 'draft'
      writeDraft(lesson)
      const line = draftSummary(lesson)
      deps.showLine(line)
      deps.say(note ? `${line} ${note}` : line)
      return { ok: true }
    },

    intercept(utterance) {
      if (phase === 'recording') {
        const cmd = matchRecordingCommand(utterance)
        if (cmd === 'stop') {
          void api.stop()
          return deps.handled
        }
        if (cmd === 'cancel') {
          api.cancel()
          return deps.handled
        }
        if (cmd === 'shot') {
          const r = rec
          void deps.capture().then((img) => {
            const ok = !!img && !!r && r === rec && r.addShot(img)
            deps.say(ok ? 'Screenshot added to this step.' : 'No screenshot taken.')
          })
          return deps.handled
        }
        return undefined
      }
      const start = matchRecordStart(utterance)
      if (start) {
        const r = api.start(start.title)
        return r.ok ? deps.handled : { mode: 'answer', text: `I can't record now: ${r.error}.` }
      }
      if (phase === 'draft' && draft && deps.now() - draftAt < VOICE_REVIEW_MS) {
        const d = matchDraftCommand(utterance)
        if (!d) return undefined
        if (d.cmd === 'read') {
          deps.say(readBack(draft))
          return deps.handled
        }
        if (d.cmd === 'play') return api.playDraft() ? deps.handled : undefined
        if (d.cmd === 'discard') {
          api.discard()
          return { mode: 'answer', text: 'Draft discarded.' }
        }
        const saved = api.save({ name: d.cmd === 'save' ? d.name : undefined })
        return 'error' in saved
          ? { mode: 'answer', text: `I could not save it: ${saved.error}.` }
          : {
              mode: 'answer',
              text: `Saved “${saved.title}”. Say “start lesson ${saved.title}” to play it.`
            }
      }
      return undefined
    }
  }
  return api
}
