import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  nextLesson,
  parseCurriculum,
  skillTree,
  type Curriculum
} from '../../src/main/teach/curriculum'
import type { Lesson } from '../../src/main/teach/lesson'
import { lessonList, learningApps } from '../../src/main/teach/picker'
import { emptyProgress } from '../../src/main/teach/progress'
import { SkillRegistry } from '../../src/main/teach/registry'
import { LESSON } from './fixtures'

const mk = (id: string, prereqs: string[] = [], level: Lesson['level'] = 'beginner'): Lesson => ({
  ...LESSON,
  id,
  title: id.toUpperCase(),
  prereqs,
  level
})

const A = mk('a')
const B = mk('b', ['a'])
const C = mk('c', ['a'])
const D = mk('d', ['b', 'c'])
const LOOSE = mk('z', [], 'advanced')
const LESSONS = [A, B, C, D, LOOSE]

const CURRICULUM: Curriculum = {
  app: 'fake',
  units: [
    { id: 'one', title: 'One', lessons: ['a', 'c'] },
    { id: 'two', title: 'Two', lessons: ['b', 'd'] }
  ]
}

const doneOf =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id)

describe('skillTree', () => {
  it('orders by unit, then lessons outside the curriculum, with status', () => {
    const tree = skillTree(LESSONS, CURRICULUM, doneOf())
    expect(tree.map((t) => [t.lesson.id, t.unit?.id ?? null, t.status])).toEqual([
      ['a', 'one', 'next'],
      ['c', 'one', 'locked'],
      ['b', 'two', 'locked'],
      ['d', 'two', 'locked'],
      ['z', null, 'open']
    ])
    expect(tree[3].needs).toEqual(['b', 'c'])
  })

  it('unlocks lessons as prereqs are done', () => {
    const tree = skillTree(LESSONS, CURRICULUM, doneOf('a', 'c'))
    expect(tree.map((t) => t.status)).toEqual(['done', 'done', 'next', 'locked', 'open'])
    expect(tree[3].needs).toEqual(['b'])
  })

  it('without a curriculum: level then pack order', () => {
    const tree = skillTree([LOOSE, A, B], undefined, doneOf())
    expect(tree.map((t) => t.lesson.id)).toEqual(['a', 'b', 'z'])
  })

  it('prereqs outside the pack never lock', () => {
    const tree = skillTree([mk('x', ['other-pack-lesson'])], undefined, doneOf())
    expect(tree[0].status).toBe('next')
  })
})

describe('nextLesson', () => {
  it('is the first unlocked lesson not done; null when all are done', () => {
    expect(nextLesson(LESSONS, CURRICULUM, doneOf())?.id).toBe('a')
    expect(nextLesson(LESSONS, CURRICULUM, doneOf('a'))?.id).toBe('c')
    expect(nextLesson(LESSONS, CURRICULUM, doneOf('a', 'c', 'b'))?.id).toBe('d')
    expect(nextLesson(LESSONS, CURRICULUM, doneOf('a', 'b', 'c', 'd'))?.id).toBe('z')
    expect(nextLesson(LESSONS, CURRICULUM, doneOf('a', 'b', 'c', 'd', 'z'))).toBeNull()
  })
})

describe('parseCurriculum', () => {
  it('accepts a valid file', () => {
    const r = parseCurriculum({ $schema: 'x', ...CURRICULUM }, LESSONS)
    expect('curriculum' in r && r.curriculum.units).toHaveLength(2)
  })

  it('reports unknown ids, duplicates and prereq order', () => {
    const r = parseCurriculum(
      { app: 'fake', units: [{ id: 'u', title: 'U', lessons: ['b', 'a', 'a', 'q'] }] },
      LESSONS
    )
    expect('error' in r && r.error).toContain('"b" comes before its prereq "a"')
    expect('error' in r && r.error).toContain('"a" is listed twice')
    expect('error' in r && r.error).toContain('unknown lesson "q"')
  })

  it('reports schema problems', () => {
    expect('error' in parseCurriculum({ app: 'fake', units: [] }, LESSONS)).toBe(true)
  })
})

describe('shipped packs', () => {
  const reg = new SkillRegistry({ builtin: join(__dirname, '..', '..', 'skills') }).load()

  it('every pack has a curriculum that loads', () => {
    expect(reg.problems()).toEqual([])
    for (const s of reg.all()) expect(s.curriculum?.units.length, s.id).toBeGreaterThan(0)
  })

  it('what to learn next in Blender', () => {
    const blender = reg.get('blender')!
    const next = (...done: string[]): string | undefined =>
      nextLesson(blender.lessons, blender.curriculum, doneOf(...done))?.id
    expect(next()).toBe('blender-basics-01-navigate-viewport')
    expect(next('blender-basics-01-navigate-viewport')).toBe('blender-basics-02-add-transform')
  })

  it('picker: units, status, mastery and next per app', () => {
    const p = emptyProgress()
    p.lessons['blender-basics-01-navigate-viewport'] = {
      completedAt: [1],
      bestTimeSec: 1,
      hintsUsed: 0,
      doItForMeCount: 0,
      skipped: 0
    }
    p.mastery = { 'blender:navigation': 0.5, 'blender:viewport': 0.5 }
    const list = lessonList(reg.all(), p, new Set(), 'blender')
    expect(list.map((l) => [l.unit?.id, l.status])).toEqual([
      ['getting-around', 'done'],
      ['getting-around', 'next'],
      ['make-something', 'locked'],
      ['make-something', 'locked'],
      ['make-something', 'locked']
    ])
    expect(list[2].needs).toEqual([reg.lesson('blender-basics-02-add-transform')!.lesson.title])
    const apps = learningApps(reg.all(), p)
    expect(apps[0]).toMatchObject({
      appId: 'blender',
      completed: 1,
      total: 5,
      next: { lessonId: 'blender-basics-02-add-transform' }
    })
    expect(apps[0].mastery).toBeGreaterThan(0)
    expect(apps[0].mastery).toBeLessThan(0.5)
  })
})
