import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
const put = vi.fn(() => 2)
vi.mock('../../src/main/labels', () => ({
  labelStore: () => ({
    put,
    exportFile: (app: string) =>
      app === 'blender'
        ? {
            format: 1,
            app: 'blender',
            labels: [
              { role: 'button', automationId: 'r', label: 'Render', source: 'ai', confidence: 0.8 }
            ]
          }
        : null
  }),
  labelsChanged: vi.fn()
}))

import {
  buildHandoff,
  installHandoff,
  listHandoffs,
  removeHandoff
} from '../../src/main/teach/handoff'
import { handoffId, handoffKind } from '../../src/main/packs/handoff-kind'
import { installPacks, PackError } from '../../src/main/packs/install'
import { zip } from '../../src/main/packs/zip-write'
import { SkillRegistry } from '../../src/main/teach/registry'
import { toStoredLesson, type Lesson } from '../../src/main/teach/lesson'
import { userLessonsDir, writeUserLesson } from '../../src/main/teach/user-lessons'
import { tempDir } from '../helpers/fixtures'

const BUILTIN = join(__dirname, '..', '..', 'skills')

const lesson = (id: string, app = 'blender'): Lesson => ({
  id,
  app,
  title: `Lesson ${id}`,
  level: 'beginner',
  minutes: 2,
  prereqs: [],
  appVersion: 'any',
  steps: [
    {
      id: 's1',
      say: 'Press Control S.',
      target: { shortcut: 'Ctrl+S' },
      check: { type: 'keypress', combo: 'Ctrl+S' },
      hints: [],
      doItForMe: { actions: [{ t: 'keys', combo: 'Ctrl+S' }] }
    }
  ]
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  put.mockClear()
})

function profile(): { root: string; reg: SkillRegistry } {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const root = join(t.dir, 'skills')
  return { root, reg: new SkillRegistry({ builtin: BUILTIN, user: root }) }
}

describe('helper handoff', () => {
  it('round-trips lessons and labels from a helper to a user', () => {
    const helper = profile()
    writeUserLesson(userLessonsDir(helper.root), lesson('blender-save-my-file'))
    writeUserLesson(userLessonsDir(helper.root), lesson('notepad-other', 'notepad'))
    helper.reg.load()
    const built = buildHandoff(
      {
        lessonIds: ['blender-save-my-file'],
        title: 'Blender for Sam',
        from: 'Ana',
        includeLabels: true
      },
      helper.reg,
      (a) =>
        a === 'blender'
          ? {
              format: 1,
              app: 'blender',
              labels: [
                {
                  role: 'button',
                  automationId: 'r',
                  label: 'Render',
                  source: 'ai',
                  confidence: 0.8
                }
              ]
            }
          : null
    )
    expect(built).toMatchObject({ id: 'handoff-blender-for-sam', lessons: 1, labels: 1 })

    const user = profile()
    user.reg.load()
    const r = installHandoff(
      { registry: () => user.reg, skillsRoot: () => user.root },
      built.data,
      'sam.lumen'
    )
    expect(r).toMatchObject({
      ok: true,
      installed: [
        {
          id: 'handoff-blender-for-sam',
          title: 'Blender for Sam',
          from: 'Ana',
          lessons: 1,
          labels: 2
        }
      ]
    })
    expect(put).toHaveBeenCalledWith('blender', 'blender', expect.any(Array), 'shared')
    // The lesson joins the Blender pack (regions, matching) and cannot act for the user.
    const found = user.reg.lesson('blender-save-my-file')
    expect(found?.skill.id).toBe('blender')
    expect(found?.lesson.steps[0].doItForMe).toBeUndefined()
    expect(user.reg.problems()).toEqual([])

    const deps = { registry: () => user.reg, skillsRoot: () => user.root }
    expect(listHandoffs(deps)).toMatchObject([{ id: 'handoff-blender-for-sam', lessons: 1 }])
    expect(removeHandoff(deps, 'handoff-blender-for-sam')).toBe(true)
    expect(user.reg.lesson('blender-save-my-file')).toBeNull()
  })

  it('needs at least one lesson', () => {
    const helper = profile()
    helper.reg.load()
    expect(() =>
      buildHandoff(
        { lessonIds: ['nope'], title: 'x', includeLabels: false },
        helper.reg,
        () => null
      )
    ).toThrow(/at least one/)
  })

  it('rejects a bad lesson, a wrong id prefix and a zip-slip path', () => {
    const { root } = profile()
    const meta = (id: string): Buffer =>
      Buffer.from(
        JSON.stringify({ format: 1, id, title: 'T', createdAt: 'now', lessons: [], labels: [] })
      )
    const install = (entries: { name: string; data: Buffer }[]): unknown =>
      installPacks(zip(entries), { kind: handoffKind(), destRoot: root, source: 't' })
    expect(() =>
      install([
        { name: 'handoff-a/handoff.json', data: meta('handoff-a') },
        { name: 'handoff-a/lessons/x.lesson.json', data: Buffer.from('{"id":1}') }
      ])
    ).toThrow(PackError)
    expect(() => install([{ name: 'blender/handoff.json', data: meta('blender') }])).toThrow(
      PackError
    )
    expect(() =>
      install([
        { name: 'handoff-a/handoff.json', data: meta('handoff-a') },
        {
          name: 'handoff-a/../../evil.lesson.json',
          data: Buffer.from(JSON.stringify(toStoredLesson(lesson('a-b'))))
        }
      ])
    ).toThrow()
  })

  it('handoffId', () => {
    expect(handoffId('Blender basics, for Sam!')).toBe('handoff-blender-basics-for-sam')
  })
})
