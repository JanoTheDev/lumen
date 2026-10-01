// A three-step lesson for engine and runner tests.
import type { Lesson } from '../../src/main/teach/lesson'

export const LESSON: Lesson = {
  id: 'fake-basics-01-three',
  app: 'fake',
  title: 'Three steps',
  level: 'beginner',
  minutes: 3,
  prereqs: [],
  appVersion: '>=1',
  steps: [
    {
      id: 'open',
      say: 'Open the File menu.',
      target: { element: { name: 'File', role: 'menuitem' } },
      check: { type: 'uia-event', event: 'invoked', match: { name: 'File' } },
      hints: ['File is top left.', 'Press Alt then F.'],
      why: 'Menus hold the commands.'
    },
    {
      id: 'save',
      say: 'Press Control S to save.',
      target: { shortcut: 'Ctrl+S' },
      check: { type: 'keypress', combo: 'Ctrl+S' },
      hints: ['Hold Control, tap S.'],
      why: 'Saving keeps your work.',
      timeoutSec: 30
    },
    {
      id: 'look',
      say: 'Look at the title bar. Say done.',
      target: null,
      check: { type: 'manual' },
      hints: ['The title is at the very top.']
    }
  ]
}
