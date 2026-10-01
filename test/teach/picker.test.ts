import { describe, expect, it } from 'vitest'
import { lessonNumber, matchAppOnly } from '../../src/main/teach/commands'
import type { Lesson } from '../../src/main/teach/lesson'
import { lessonList, progressView } from '../../src/main/teach/picker'
import { PRACTICE_LESSON } from '../../src/main/teach/practice-lesson'
import { emptyProgress, type Progress } from '../../src/main/teach/progress'
import type { Skill } from '../../src/main/teach/registry'
import { IDLE } from '../../src/main/teach/state'
import { LESSON } from './fixtures'

const lesson = (id: string, title: string, level: Lesson['level']): Lesson => ({
  ...LESSON,
  id,
  title,
  level
})

const skill = (id: string, name: string, lessons: Lesson[]): Skill => ({
  id,
  name,
  version: '1.0.0',
  dir: '',
  match: { process: [`${id}.exe`] },
  regions: {},
  source: 'builtin',
  lessons
})

const BLENDER = skill('blender', 'Blender', [
  lesson('blender-adv', 'Advanced thing', 'advanced'),
  lesson('blender-nav', 'Navigate the viewport', 'beginner'),
  lesson('blender-add', 'Add an object', 'beginner')
])
const MINE = skill('general', 'Your guides', [
  lesson('general-mail', 'Compose in Gmail', 'beginner')
])

describe('lessonList', () => {
  const progress: Progress = {
    ...emptyProgress(),
    lessons: {
      'blender-add': { completedAt: [1, 2], bestTimeSec: 9, hintsUsed: 0, doItForMe: 0, skipped: 0 }
    }
  }

  it('lists apps by name, beginner lessons first, with completions and source', () => {
    const list = lessonList([MINE, BLENDER], progress, new Set(['general-mail']))
    expect(list.map((l) => l.id)).toEqual([
      'blender-nav',
      'blender-add',
      'blender-adv',
      'general-mail'
    ])
    expect(list[1]).toMatchObject({ appName: 'Blender', completed: 2, source: 'pack', steps: 3 })
    expect(list[3].source).toBe('user')
  })

  it('filters by app', () => {
    expect(lessonList([MINE, BLENDER], progress, new Set(), 'general').map((l) => l.id)).toEqual([
      'general-mail'
    ])
  })
})

describe('progressView', () => {
  const find = (id: string): { lesson: Lesson; skill: Skill } | null => {
    const l = BLENDER.lessons.find((x) => x.id === id)
    return l ? { lesson: l, skill: BLENDER } : null
  }

  it('shows the running lesson', () => {
    const running = {
      ...IDLE,
      phase: 'step.waiting' as const,
      lesson: BLENDER.lessons[1],
      index: 1
    }
    expect(progressView(emptyProgress(), running, 0, find).active).toEqual({
      lessonId: 'blender-nav',
      title: 'Navigate the viewport',
      appName: 'Blender',
      step: 2,
      total: 3,
      running: true
    })
  })

  it('shows a lesson left part-way, and recent completions newest first', () => {
    const p: Progress = {
      ...emptyProgress(),
      active: {
        lessonId: 'blender-add',
        stepId: 'save',
        stepIndex: 1,
        source: 'pack',
        startedAt: 0,
        updatedAt: 1000,
        pausedAt: 1000,
        pace: 1,
        steps: {}
      },
      lessons: {
        'blender-nav': {
          completedAt: [50],
          bestTimeSec: 1,
          hintsUsed: 0,
          doItForMe: 0,
          skipped: 0
        },
        'blender-adv': {
          completedAt: [90],
          bestTimeSec: 1,
          hintsUsed: 0,
          doItForMe: 0,
          skipped: 0
        },
        gone: { completedAt: [99], bestTimeSec: 1, hintsUsed: 0, doItForMe: 0, skipped: 0 }
      }
    }
    const v = progressView(p, IDLE, 2000, find)
    expect(v.active).toMatchObject({ lessonId: 'blender-add', step: 2, running: false })
    expect(v.recent.map((r) => r.lessonId)).toEqual(['blender-adv', 'blender-nav'])
  })
})

describe('voice picking (teach me blender, start lesson 2)', () => {
  it('matchAppOnly finds an app named on its own', () => {
    const apps = [BLENDER, skill('davinci-resolve', 'DaVinci Resolve', [])]
    expect(matchAppOnly('blender', apps)).toBe('blender')
    expect(matchAppOnly('davinci resolve', apps)).toBe('davinci-resolve')
    expect(matchAppOnly('extrude in blender', apps)).toBeNull()
  })

  it.each([
    ['2', 2],
    ['two', 2],
    ['number 3', 3],
    ['the second one', 2],
    ['make a folder', null],
    ['0', null]
  ])('lessonNumber(%j) = %j', (q, n) => expect(lessonNumber(q)).toBe(n))
})

describe('practice lesson', () => {
  it('checks the three board buttons by invoke events', () => {
    expect(PRACTICE_LESSON.steps.map((s) => s.check)).toEqual(
      ['Send', 'Save', 'Cancel'].map((name) => ({
        type: 'uia-event',
        event: 'invoked',
        match: { name, role: 'button' }
      }))
    )
  })
})
