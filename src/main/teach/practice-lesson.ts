// The onboarding mini lesson (setup step "Mini lesson"): three clicks on the practice board in
// the setup window. The board reports its clicks (teach:practice), which stand in for UIA
// invoke events, so the checks work without any screen reading.
import type { Lesson, LessonStep } from './lesson'

export const PRACTICE_LESSON_ID = 'lumen-practice'

const step = (label: string, color: string, say: string, hint: string): LessonStep => ({
  id: label.toLowerCase(),
  say,
  target: { element: { name: label, role: 'button' } },
  check: { type: 'uia-event', event: 'invoked', match: { name: label, role: 'button' } },
  hints: [hint, `Look for the ${color} button that says ${label}. Or say “click it”.`],
  why: 'In a lesson I point at what to use, and I notice when you have done it.'
})

export const PRACTICE_LESSON: Lesson = {
  id: PRACTICE_LESSON_ID,
  app: 'lumen',
  title: 'Mini lesson',
  level: 'beginner',
  minutes: 1,
  prereqs: [],
  appVersion: 'any',
  steps: [
    step('Send', 'blue', 'Click the blue Send button.', 'It is the first button on the board.'),
    step('Save', 'green', 'Now click the green Save button.', 'It is next to Send.'),
    step('Cancel', 'grey', 'Last one. Click the grey Cancel button.', 'It is the last button.')
  ]
}
