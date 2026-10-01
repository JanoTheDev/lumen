import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { HowtoCache, PAID_PER_DAY, PAID_PER_TASK } from '../../src/main/howto/cache'
import { createLearner } from '../../src/main/howto/learn'
import { AppNotesStore, FAILS_TO_DROP, MAX_FILE_BYTES, goalMatch } from '../../src/main/howto/notes'
import { noteGoal } from '../../src/main/howto/goal'
import type { AppIdentity, HowtoResult } from '../../src/main/howto/types'

const root = mkdtempSync(join(tmpdir(), 'lumen-notes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (): string => join(root, `d${++n}`)

const PAINT: AppIdentity = { app: 'Paint.NET', appId: 'paintdotnet', version: '5.1.2.0' }

describe('app notes', () => {
  it('keeps a path and finds it again by a similar goal', () => {
    const s = new AppNotesStore(fresh())
    expect(
      s.recordSuccess(PAINT, 'Resize the image', { ui: ['Image', 'Resize'], shortcut: 'Ctrl+R' })
    ).toBe(true)
    expect(s.find(PAINT, 'resize the image please')?.path).toEqual({
      ui: ['Image', 'Resize'],
      shortcut: 'Ctrl+R'
    })
    expect(s.find(PAINT, 'rotate the layer')).toBeNull()
    expect(goalMatch('Resize image', 'resize the image')).toBe(1)
  })

  it('drops notes of an older major version when the app updates', () => {
    const s = new AppNotesStore(fresh())
    s.recordSuccess(PAINT, 'Resize the image', { ui: ['Image', 'Resize'] })
    const minor = { ...PAINT, version: '5.2.0.0' }
    expect(s.find(minor, 'resize the image')).not.toBeNull()
    const major = { ...PAINT, version: '6.0.0.0' }
    expect(s.find(major, 'resize the image')).toBeNull()
    expect(s.list(PAINT.appId)).toEqual([])
  })

  it('removes a note after it failed twice; a success resets the count', () => {
    const s = new AppNotesStore(fresh())
    s.recordSuccess(PAINT, 'Add a layer', { ui: ['Layers', 'Add New Layer'] })
    expect(s.recordFailure(PAINT, 'Add a layer')).toBe(false)
    s.recordSuccess(PAINT, 'Add a layer', { ui: ['Layers', 'Add New Layer'] })
    expect(s.list(PAINT.appId)[0].fails).toBe(0)
    expect(s.recordFailure(PAINT, 'Add a layer')).toBe(false)
    expect(s.recordFailure(PAINT, 'Add a layer')).toBe(FAILS_TO_DROP === 2)
    expect(s.find(PAINT, 'add a layer')).toBeNull()
  })

  it('never keeps secrets or long content names, and stays under the size cap', () => {
    const dir = fresh()
    const s = new AppNotesStore(dir)
    const key = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-')
    expect(s.recordSuccess(PAINT, `paste ${key}`, { ui: ['Paste'] })).toBe(false)
    expect(s.recordSuccess(PAINT, 'Open settings', { ui: [key, 'x'.repeat(80)] })).toBe(false)
    for (let i = 0; i < 80; i++)
      s.recordSuccess(PAINT, `goal number ${i} ${'w'.repeat(i % 7)}`, {
        ui: ['Menu one', 'Menu two', 'A fairly long button label'],
        automationIds: ['AutomationIdForTheButton' + i]
      })
    const file = join(dir, 'paintdotnet.json')
    expect(statSync(file).size).toBeLessThanOrEqual(MAX_FILE_BYTES)
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant')
  })
})

describe('how-to cache and paid budget', () => {
  const r: HowtoResult = {
    app: 'Paint.NET',
    version: '5.1.2.0',
    goal: 'resize the image',
    steps: [{ text: 'Image > Resize', ui: ['Image', 'Resize'] }],
    sources: [],
    from: 'web-search',
    searches: 1,
    costUsd: 0.02
  }

  it('hits by app + major version + goal, persists, and expires', () => {
    let now = 1_000_000
    const path = join(fresh(), 'howto-cache.json')
    new HowtoCache(path, () => now).put(PAINT, 'resize the image', r)
    const c = new HowtoCache(path, () => now)
    expect(c.get(PAINT, 'Resize image')).toMatchObject({ from: 'cache', costUsd: 0, searches: 0 })
    expect(c.get({ ...PAINT, version: '6.0' }, 'resize the image')).toBeNull()
    now += 31 * 24 * 60 * 60_000
    expect(c.get(PAINT, 'resize the image')).toBeNull()
  })

  it('caps paid searches per task and per day', () => {
    let now = new Date(2026, 9, 1, 10).getTime()
    const c = new HowtoCache(null, () => now)
    expect(c.paidLeft('t1')).toBe(PAID_PER_TASK)
    c.notePaid('t1', 2)
    expect(c.paidLeft('t1')).toBe(0)
    for (let i = 2; i < 6; i++) c.notePaid(`t${i}`, 2)
    expect(c.paidLeft('t9')).toBe(0)
    expect(PAID_PER_DAY).toBe(10)
    now = new Date(2026, 9, 2, 10).getTime()
    expect(c.paidLeft('t9')).toBe(PAID_PER_TASK)
  })
})

describe('task learner', () => {
  it('builds a path per goal from what worked and drops a used note after two failures', async () => {
    const store = new AppNotesStore(fresh())
    const learner = createLearner({ notes: () => store, identify: async () => PAINT })
    await learner.acted('Resize the image', 'click', { name: 'Image', role: 'menuitem' })
    await learner.acted('Resize the image', 'click', {
      name: 'Holiday photo.png',
      role: 'listitem'
    })
    await learner.acted('Resize the image', 'type', { name: 'Width' })
    await learner.acted('Resize the image', 'invoke', {
      name: 'Resize…',
      automationId: 'ResizeCmd',
      role: 'MenuItem'
    })
    await learner.pressed('Resize the image', 'enter')
    const note = store.find(PAINT, 'resize the image')
    expect(note?.path).toEqual({ ui: ['Image', 'Resize…'], automationIds: ['ResizeCmd'] })

    learner.looked(PAINT, {
      ...{ app: 'Paint.NET', version: '5.1.2.0', searches: 0, costUsd: 0, sources: [] },
      goal: note!.goal,
      from: 'notes',
      steps: [{ text: 'Image > Resize…', ui: ['Image', 'Resize…'] }]
    })
    await learner.failed('Something else')
    expect(store.find(PAINT, 'resize the image')).not.toBeNull()
    await learner.failed('resize')
    await learner.failed('Resize…')
    expect(store.find(PAINT, 'resize the image')).toBeNull()
  })

  it('does nothing while memory is off', async () => {
    const learner = createLearner({ notes: () => null, identify: async () => PAINT })
    await expect(learner.acted('x', 'click', { name: 'File' })).resolves.toBeUndefined()
  })
})

describe('app notes keep the task, not its content (review 4)', () => {
  it('drops addresses, quoted text and what to write from the goal', () => {
    const dir = fresh()
    const s = new AppNotesStore(dir)
    expect(
      s.recordSuccess(PAINT, 'email anna@clinic.example that my test results are positive', {
        ui: ['New mail']
      })
    ).toBe(true)
    s.recordSuccess(PAINT, 'Reply to Sarah saying "I am resigning on Friday"', { ui: ['Reply'] })
    s.recordSuccess(PAINT, 'Attach report-Q3.pdf: the numbers', { ui: ['Attach'] })
    const file = readFileSync(join(dir, 'paintdotnet.json'), 'utf8')
    for (const secret of ['anna@clinic', 'positive', 'resigning', 'report-Q3', 'numbers'])
      expect(file).not.toContain(secret)
    expect(noteGoal('Reply to Sarah that I am resigning')).toBe('Reply to Sarah')
    expect(noteGoal('anna@clinic.example')).toBeNull()
    expect(noteGoal('Change the default font')).toBe('Change the default font')
  })

  it('drops UI names that are addresses or file names', () => {
    const dir = fresh()
    const s = new AppNotesStore(dir)
    s.recordSuccess(PAINT, 'attach a file', {
      ui: ['Attach files', 'report-Q3.pdf', 'Anna <anna@clinic.example>', 'Open']
    })
    expect(s.find(PAINT, 'attach a file')?.path.ui).toEqual(['Attach files', 'Open'])
  })

  it('learns nothing without a goal (no plan step) and no browser tab titles', async () => {
    const store = new AppNotesStore(fresh())
    const CHROME: AppIdentity = { app: 'Gmail', appId: 'gmail', version: '', browser: true }
    const learner = createLearner({ notes: () => store, identify: async () => CHROME })
    await learner.acted('', 'click', { name: 'Compose', role: 'button' })
    expect(store.list('gmail')).toEqual([])
    await learner.acted('Write a new email', 'click', {
      name: 'Inbox - jane - Gmail',
      role: 'tabitem'
    })
    await learner.acted('Write a new email', 'click', { name: 'Compose', role: 'button' })
    expect(store.find(CHROME, 'write a new email')?.path.ui).toEqual(['Compose'])
  })
})
