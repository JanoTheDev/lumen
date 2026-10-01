import { describe, expect, it } from 'vitest'
import {
  lessonPhrases,
  matchStartLesson,
  parseLessonCommand,
  pickLesson,
  type LessonCandidate
} from '../../src/main/teach/commands'
import { lessonContextLine } from '../../src/main/teach/context'
import { lessonKeysAllowed, lessonUrlAllowed } from '../../src/main/teach/safety'
import { LESSON_COMMANDS } from '../../src/main/teach/state'

describe('parseLessonCommand', () => {
  it.each([
    ['next', 'next'],
    ['Next step.', 'next'],
    ['okay, next please', 'next'],
    ['back', 'back'],
    ['go back', 'back'],
    ['say that again', 'repeat'],
    ['skip this step', 'skip'],
    ['stop the lesson', 'stop'],
    ['hold on', 'pause'],
    ['resume', 'resume'],
    ["I'm stuck", 'help'],
    ['help', 'help'],
    ['do it for me', 'do-it'],
    ['why?', 'why'],
    ['done', 'done'],
    ['I did it!', 'done'],
    ['slow down', 'slower'],
    ['faster', 'faster'],
    ['yes', 'yes'],
    ['OK.', 'yes'],
    ['no thanks', 'no']
  ])('"%s" → %s', (utterance, cmd) => {
    expect(parseLessonCommand(utterance)).toBe(cmd)
  })

  it.each([
    "what's the weather",
    'go back to gmail',
    'help me write an email to Sam',
    'next week I have a meeting',
    'why is the sky blue',
    'stop',
    ''
  ])('"%s" is not a lesson command', (utterance) => {
    expect(parseLessonCommand(utterance)).toBeNull()
  })

  it('every command has phrases', () => {
    for (const c of LESSON_COMMANDS) {
      const phrases = lessonPhrases()[c]
      expect(phrases.length).toBeGreaterThan(0)
      for (const p of phrases) expect(parseLessonCommand(p)).toBe(c)
    }
  })
})

const LESSONS: LessonCandidate[] = [
  {
    id: 'blender-basics-02-add-object',
    title: 'Add and move an object',
    appId: 'blender',
    appName: 'Blender'
  },
  {
    id: 'blender-basics-01-navigate',
    title: 'Move around the 3D viewport',
    appId: 'blender',
    appName: 'Blender'
  },
  {
    id: 'windows-basics-03-explorer-folders',
    title: 'Make and use folders',
    appId: 'windows',
    appName: 'Windows 11'
  },
  {
    id: 'windows-basics-01-display-scaling',
    title: 'Make text and apps bigger',
    appId: 'windows',
    appName: 'Windows 11'
  }
]

describe('starting a lesson by voice', () => {
  it('matches start phrases', () => {
    expect(matchStartLesson('start lesson make text bigger')).toBe('make text bigger')
    expect(matchStartLesson('Teach me Blender')).toBe('blender')
    expect(matchStartLesson('teach me how to make folders')).toBe('make folders')
    expect(matchStartLesson('what is a lesson')).toBeNull()
  })

  it('an app name alone picks its first lesson', () => {
    expect(pickLesson('blender', LESSONS)?.id).toBe('blender-basics-01-navigate')
  })

  it('a title picks the lesson with the most shared words', () => {
    expect(pickLesson('make text bigger', LESSONS)?.id).toBe('windows-basics-01-display-scaling')
    expect(pickLesson('folders', LESSONS)?.id).toBe('windows-basics-03-explorer-folders')
  })

  it('a weak match picks nothing', () => {
    expect(pickLesson('quantum physics homework', LESSONS)).toBeNull()
  })
})

describe('lesson action policy', () => {
  it('allows lesson keys except the hard denies', () => {
    expect(lessonKeysAllowed('Win+I')).toBe(true)
    expect(lessonKeysAllowed('Win+Left')).toBe(true)
    expect(lessonKeysAllowed('Win+R')).toBe(false)
    expect(lessonKeysAllowed('Ctrl+Alt+Delete')).toBe(false)
  })

  it('allows https and plain ms-settings pages only', () => {
    expect(lessonUrlAllowed('ms-settings:display')).toBe(true)
    expect(lessonUrlAllowed('ms-settings:easeofaccess-narrator')).toBe(true)
    expect(lessonUrlAllowed('https://example.com/a')).toBe(true)
    expect(lessonUrlAllowed('http://example.com')).toBe(false)
    expect(lessonUrlAllowed('ms-settings:display;calc.exe')).toBe(false)
    expect(lessonUrlAllowed('file:///C:/Windows/system32/cmd.exe')).toBe(false)
    expect(lessonUrlAllowed('ms-cxh:foo')).toBe(false)
  })
})

describe('lesson context line', () => {
  it('names the app, lesson and step', () => {
    expect(
      lessonContextLine({ app: 'Blender', lessonTitle: 'Add an object', stepSay: 'Press Shift A.' })
    ).toBe(
      'lesson: the user is in the Blender lesson "Add an object"; current step: "Press Shift A.". Answer with this step in mind.'
    )
  })
})
