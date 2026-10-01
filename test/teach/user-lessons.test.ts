import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SavedGuide } from '../../src/shared/types'
import { parseLesson, toStoredLesson } from '../../src/main/teach/lesson'
import { guideToLesson, migrateGuides } from '../../src/main/teach/migrate-guides'
import { SkillRegistry, hasMatchRules } from '../../src/main/teach/registry'
import {
  deleteUserLesson,
  freeLessonId,
  userLessonPath,
  userLessonsDir,
  writeUserLesson
} from '../../src/main/teach/user-lessons'
import { LESSON } from './fixtures'

const GUIDE: SavedGuide = {
  id: 'compose-in-gmail-abc',
  name: 'Compose in Gmail',
  task: 'how do I write an email in gmail',
  createdAt: 1,
  steps: [
    {
      label: 'Click the Compose button',
      target_hint: 'Compose',
      bbox: { x: 1, y: 2, w: 3, h: 4 }
    },
    { label: 'Type the address in To', target_hint: 'To', detail: 'It is the first field.' }
  ]
}

describe('stored lesson round trip', () => {
  it('toStoredLesson parses back to the same lesson', () => {
    expect(parseLesson(toStoredLesson(LESSON))).toEqual(LESSON)
  })
})

describe('guideToLesson', () => {
  it('turns labels into say, hints into text targets and drops bboxes', () => {
    const l = guideToLesson(GUIDE, 'general-compose-in-gmail')!
    expect(l.app).toBe('general')
    expect(l.title).toBe('Compose in Gmail')
    expect(l.steps.map((s) => s.say)).toEqual([
      'Click the Compose button',
      'Type the address in To'
    ])
    expect(l.steps[0].target).toEqual({ text: 'Compose' })
    expect(l.steps[0].check).toEqual({ type: 'manual' })
    expect(l.steps[1].hints).toEqual(['It is the first field.'])
    expect(JSON.stringify(l)).not.toContain('bbox')
  })

  it('returns null for a guide without steps', () => {
    expect(guideToLesson({ ...GUIDE, steps: [] }, 'general-x')).toBeNull()
  })
})

describe('user lesson files and guide migration', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lumen-ul-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('rejects ids that are malformed or escape the folder', () => {
    expect(userLessonPath(root, '../x')).toBeNull()
    expect(userLessonPath(root, 'Bad Id')).toBeNull()
    expect(userLessonPath(root, 'ok-id')).toContain('ok-id.lesson.json')
  })

  it('picks a free id and deletes by id', () => {
    const dir = join(root, 'lessons')
    const id = freeLessonId(dir, 'fake', 'Three steps!')
    expect(id).toBe('fake-three-steps')
    writeUserLesson(dir, { ...LESSON, id })
    expect(freeLessonId(dir, 'fake', 'Three steps')).toBe('fake-three-steps-2')
    expect(deleteUserLesson(dir, id)).toBe(true)
    expect(deleteUserLesson(dir, id)).toBe(false)
  })

  it('migrates guides once, keeps the originals in guides.bak and the lessons play', () => {
    const guidesDir = join(root, 'guides')
    mkdirSync(guidesDir)
    writeFileSync(join(guidesDir, `${GUIDE.id}.json`), JSON.stringify(GUIDE))
    writeFileSync(join(guidesDir, 'broken.json'), '{nope')
    const skills = join(root, 'skills')
    const dirs = {
      guidesDir,
      lessonsDir: userLessonsDir(skills),
      backupDir: join(root, 'guides.bak')
    }
    const r = migrateGuides(dirs)
    expect(r.migrated).toEqual([
      { guide: 'Compose in Gmail', lessonId: 'general-compose-in-gmail' }
    ])
    expect(r.failed).toHaveLength(1)
    expect(existsSync(join(root, 'guides.bak', `${GUIDE.id}.json`))).toBe(true)
    expect(readdirSync(guidesDir)).toEqual(['broken.json'])
    expect(migrateGuides(dirs).migrated).toEqual([])

    const reg = new SkillRegistry({ builtin: join(root, 'none'), user: skills }).load()
    expect(reg.problems()).toEqual([])
    const found = reg.lesson('general-compose-in-gmail')!
    expect(found.skill.name).toBe('Your guides')
    expect(found.skill.source).toBe('user')
    expect(hasMatchRules(found.skill)).toBe(false)
    expect(reg.matchApp({ process: 'chrome.exe', title: 'Gmail' })).toBeNull()
  })
})
