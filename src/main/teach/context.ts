// The running lesson as context for normal queries ("what does this button do?" during a
// lesson is answered with the lesson in mind). Kept tiny so the prompt side can import it
// without pulling in the lesson engine.
export interface LessonContext {
  app: string
  lessonTitle: string
  stepSay: string
}

let provider: () => LessonContext | null = () => null

export function setLessonContextProvider(fn: (() => LessonContext | null) | null): void {
  provider = fn ?? (() => null)
}

export function lessonContext(): LessonContext | null {
  return provider()
}

/** One line for the user turn. */
export function lessonContextLine(c: LessonContext): string {
  return `lesson: the user is in the ${c.app} lesson "${c.lessonTitle}"; current step: "${c.stepSay}". Answer with this step in mind.`
}
