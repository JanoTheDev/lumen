import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  matchDraftCommand,
  matchRecordingCommand,
  matchRecordStart
} from '../../src/main/teach/commands'
import type { RawUiaEvent } from '../../src/main/teach/recorder'
import { createRecorder, type RecordingDeps } from '../../src/main/teach/recording'

const HANDLED = { handled: true }

let dir: string
let feed: { uia(e: RawUiaEvent): void; key(c: string): void } | null
let unsubscribed: number
let now: number
let deps: RecordingDeps & {
  said: string[]
  states: (string | null)[]
  lines: string[]
  played: number
  draftText: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'lumen-record-'))
  feed = null
  unsubscribed = 0
  now = 1_000_000
  const said: string[] = []
  const states: (string | null)[] = []
  const lines: string[] = []
  deps = {
    said,
    states,
    lines,
    played: 0,
    now: () => now,
    foreground: async () => ({ id: 'windows', name: 'Windows 11', process: 'SystemSettings.exe' }),
    subscribe: (on) => {
      feed = on
      return () => {
        feed = null
        unsubscribed++
      }
    },
    capture: async () => ({ data: 'img', mime: 'image/jpeg' }),
    draftText: vi.fn(async () => ({
      title: 'Turn on dark mode',
      steps: [
        { from: 1, say: 'Select Personalization in the left list.', why: '', hint: '' },
        { from: 3, say: 'Select Dark.', why: '', hint: '' }
      ]
    })),
    hotkey: () => 'Ctrl+Shift+Space',
    showState: (t) => states.push(t),
    showLine: (t) => lines.push(t),
    say: (t) => said.push(t),
    lessonsDir: () => join(dir, 'lessons'),
    draftFile: () => join(dir, 'teach', 'draft.lesson.json'),
    reload: vi.fn(),
    play: () => {
      deps.played++
      return true
    },
    lessonRunning: () => false,
    appName: (id) => (id === 'windows' ? 'Windows 11' : id),
    log: () => {},
    handled: HANDLED
  }
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

async function recordDarkMode(rec: ReturnType<typeof createRecorder>): Promise<void> {
  expect(rec.intercept('watch me turn on dark mode')).toBe(HANDLED)
  await vi.advanceTimersByTimeAsync(10)
  feed!.uia({ kind: 'selected', element: { name: 'Personalization', role: 'list item' } })
  now += 3000
  feed!.uia({ kind: 'value', element: { name: 'Search', role: 'edit', value: 'typed secret' } })
  now += 3000
  feed!.uia({ kind: 'selected', element: { name: 'Dark', role: 'list item' } })
  expect(rec.intercept('stop recording')).toBe(HANDLED)
  await vi.advanceTimersByTimeAsync(10)
}

describe('record my steps', () => {
  it('records, drafts with the fast model, and saves by voice', async () => {
    const rec = createRecorder(deps)
    await recordDarkMode(rec)
    expect(deps.states[0]).toMatch(/^● Recording your steps/)
    expect(deps.states.at(-1)).toBeNull()
    expect(unsubscribed).toBe(1)
    // The model saw the steps, never the typed text.
    const input = deps.draftText.mock.calls[0][0]
    expect(input.title).toBe('turn on dark mode')
    expect(JSON.stringify(input)).not.toContain('typed secret')
    expect(deps.lines[0]).toMatch(/Draft ready: “Turn on dark mode”, 2 steps/)
    expect(existsSync(deps.draftFile())).toBe(true)

    const status = rec.status()
    expect(status.phase).toBe('draft')
    expect(status.draft?.appName).toBe('Windows 11')
    expect(status.draft?.steps.map((s) => s.waitsFor)).toEqual([
      '“Personalization” being selected',
      '“Dark” being selected'
    ])

    expect(rec.intercept('read it back')).toBe(HANDLED)
    expect(deps.said.at(-1)).toMatch(/Step 1: Select Personalization/)
    expect(rec.intercept('try it')).toBe(HANDLED)
    expect(deps.played).toBe(1)

    const reply = rec.intercept('save it as Dark mode please') as { text: string }
    expect(reply.text).toMatch(/Saved “Dark mode please”/)
    expect(readdirSync(join(dir, 'lessons'))).toEqual(['windows-dark-mode-please.lesson.json'])
    expect(existsSync(deps.draftFile())).toBe(false)
    expect(deps.reload).toHaveBeenCalled()
    expect(rec.status()).toEqual({ phase: 'idle', events: 0, draft: null })
  })

  it('keeps the draft across restarts and saves edits from Settings', async () => {
    await recordDarkMode(createRecorder(deps))
    const again = createRecorder(deps)
    const draft = again.status().draft!
    expect(draft.title).toBe('Turn on dark mode')
    const saved = again.save({
      title: 'Dark mode',
      steps: [{ id: draft.steps[1].id, say: 'Choose Dark.' }]
    })
    expect('error' in saved).toBe(false)
    if (!('error' in saved)) expect(saved.steps.map((s) => s.say)).toEqual(['Choose Dark.'])
  })

  it('uses plain lines when the model fails', async () => {
    deps.draftText.mockRejectedValueOnce(new Error('no key'))
    const rec = createRecorder(deps)
    await recordDarkMode(rec)
    expect(rec.status().draft?.steps.map((s) => s.say)).toEqual([
      'Select Personalization.',
      'Type what you need in the Search box.',
      'Select Dark.'
    ])
  })

  it('cancel keeps nothing; no steps makes no draft', async () => {
    const rec = createRecorder(deps)
    rec.start()
    feed!.key('Ctrl+S')
    expect(rec.intercept('cancel recording')).toBe(HANDLED)
    expect(rec.status().phase).toBe('idle')
    expect(feed).toBeNull()

    rec.start()
    await expect(rec.stop()).resolves.toEqual({ ok: false, error: 'no steps recorded' })
    expect(deps.draftText).not.toHaveBeenCalled()
    expect(existsSync(deps.draftFile())).toBe(false)
  })

  it('takes a screenshot only when asked, and stops by itself after 10 minutes', async () => {
    const rec = createRecorder(deps)
    rec.start()
    feed!.uia({ kind: 'invoked', element: { name: 'Save', role: 'button' } })
    expect(rec.intercept('take a screenshot')).toBe(HANDLED)
    await vi.advanceTimersByTimeAsync(10)
    expect(deps.said.at(-1)).toBe('Screenshot added to this step.')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rec.status().phase).toBe('draft')
    expect(deps.draftText.mock.calls[0][1]).toEqual([{ data: 'img', mime: 'image/jpeg' }])
  })

  it('does not start while a lesson runs, or twice', () => {
    const rec = createRecorder({ ...deps, lessonRunning: () => true })
    expect(rec.start()).toEqual({ ok: false, error: 'stop the lesson first' })
    const rec2 = createRecorder(deps)
    rec2.start()
    expect(rec2.start().ok).toBe(false)
  })

  it('answers draft review commands only for a while after the draft', async () => {
    const rec = createRecorder(deps)
    await recordDarkMode(rec)
    now += 11 * 60_000
    expect(rec.intercept('save it')).toBeUndefined()
    expect(rec.status().draft).not.toBeNull()
  })
})

describe('record voice commands', () => {
  it('starts on "watch me …"', () => {
    expect(matchRecordStart('Watch me do this')).toEqual({})
    expect(matchRecordStart('watch me turn on dark mode')).toEqual({ title: 'turn on dark mode' })
    expect(matchRecordStart('record my steps')).toEqual({})
    expect(matchRecordStart('record this lesson')).toBeNull()
    expect(matchRecordStart('watch the video')).toBeNull()
  })

  it('stop / cancel / screenshot while recording', () => {
    expect(matchRecordingCommand('Stop recording.')).toBe('stop')
    expect(matchRecordingCommand("that's it")).toBe('stop')
    expect(matchRecordingCommand('cancel recording')).toBe('cancel')
    expect(matchRecordingCommand('take a screenshot')).toBe('shot')
    expect(matchRecordingCommand('open settings')).toBeNull()
  })

  it('draft review', () => {
    expect(matchDraftCommand('save it as Dark mode')).toEqual({ cmd: 'save', name: 'Dark mode' })
    expect(matchDraftCommand('save it')).toEqual({ cmd: 'save' })
    expect(matchDraftCommand('read it back')).toEqual({ cmd: 'read' })
    expect(matchDraftCommand('try it')).toEqual({ cmd: 'play' })
    expect(matchDraftCommand('discard the draft')).toEqual({ cmd: 'discard' })
    expect(matchDraftCommand('save the file')).toBeNull()
  })
})

describe('skill output mode (11 T11)', () => {
  it('hands the recorded steps to the skill sink instead of drafting a lesson', async () => {
    const skillOut = vi.fn(async () => {})
    const rec = createRecorder({ ...deps, skillOut })
    expect(rec.start('export png', 'skill')).toEqual({ ok: true })
    expect(deps.said.at(-1)).toMatch(/new skill/)
    await vi.advanceTimersByTimeAsync(10)
    feed!.uia({ kind: 'invoked', element: { name: 'Export As', role: 'menu item' } })
    now += 2000
    feed!.uia({ kind: 'value', element: { name: 'File name', role: 'edit', value: 'secret.png' } })
    expect(rec.intercept('stop recording')).toBe(HANDLED)
    await vi.advanceTimersByTimeAsync(10)
    expect(skillOut).toHaveBeenCalledTimes(1)
    const input = (skillOut.mock.calls[0] as unknown as [{ title?: string; steps: unknown[] }])[0]
    expect(input.title).toBe('export png')
    expect(input.steps).toHaveLength(2)
    expect(JSON.stringify(input)).not.toContain('secret.png')
    expect(deps.draftText).not.toHaveBeenCalled()
    expect(rec.status().draft).toBeNull()
    expect(rec.status().phase).toBe('idle')
  })

  it('refuses skill mode without a sink', () => {
    const rec = createRecorder(deps)
    expect(rec.start(undefined, 'skill')).toEqual({ ok: false, error: 'skills are not ready' })
  })
})
