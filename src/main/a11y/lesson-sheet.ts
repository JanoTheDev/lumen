// Lesson words (07 T16) for the "what can I say" sheet, pure: one row per lesson command,
// shown with the `lesson` gate. teach/commands.ts matches them before the grammar.
import type { LessonCommand } from '@shared/events'
import { lessonPhrases } from '../teach/commands'
import type { GrammarEntry } from './voice-commands'

const LESSON_DOES: Record<LessonCommand, string> = {
  next: 'Go to the next lesson step',
  back: 'Go back one step',
  repeat: 'Say the step again',
  skip: 'Skip this step',
  stop: 'End the lesson',
  pause: 'Pause the lesson',
  resume: 'Carry on with a paused lesson',
  help: 'Get a hint for this step',
  'do-it': 'Let Lumen do this step for you',
  why: 'Hear why this step matters',
  done: 'Say you finished the step',
  slower: 'Give yourself more time per step',
  faster: 'Give yourself less time per step',
  yes: 'Answer yes to a lesson question',
  no: 'Answer no to a lesson question',
  perform: 'Click or press what the step points at'
}

/** The running lesson's words (teach/commands.ts), one row per command: first phrase, others. */
export function lessonSheetEntries(
  phrases: Record<LessonCommand, readonly string[]> = lessonPhrases()
): GrammarEntry[] {
  return (Object.keys(LESSON_DOES) as LessonCommand[]).map((cmd) => {
    const [say = cmd, ...more] = phrases[cmd] ?? []
    const also = more.slice(0, 3)
    return {
      id: `lesson.${cmd}`,
      category: 'guide',
      patterns: [],
      gate: 'lesson',
      say,
      does: `${LESSON_DOES[cmd]}${also.length ? ` (also “${also.join('”, “')}”)` : ''}`
    }
  })
}
