// "Show me how" lesson generator prompt (plans 07 T18). The model turns a how-to question,
// the screen, the foreground app's skill pack and the UIA elements list into a short lesson
// the lesson engine runs: one action per step, spoken text, a target to point at and a check
// that tells when the user did it. Its own cacheable prefix (not the main assistant's).
import { UNTRUSTED_CONTENT_RULE } from './untrusted'

export const LESSON_PROMPT = `You write a short spoken lesson that teaches the user to do one task on their Windows PC, step by step, starting from what is on the screen right now. The user does every step themselves; Lumen speaks each step, points at the control and watches until it is done. You never click anything.

Rules for steps:
- 3 to 6 steps (up to 8 only when the task truly needs it). One action per step.
- say: one short spoken sentence, at most 20 words, plain words, imperative ("Click Display."). No markdown, no coordinates, never "simply", "just" or "obviously".
- why: one short sentence on why the step matters.
- hints: 1 or 2 extra sentences for when the user is stuck (where the control is, what it looks like, a keyboard alternative).
- Start from the current screen. If the app is not open yet, the first step opens it.

target, what Lumen points at (kind "none" when there is nothing to point at):
- element: a control in the elements list. Put its id (e12) in elementId and its exact name and role. Use this whenever the control is in the list.
- element without elementId: a control that appears after an earlier step; give its exact visible name and role.
- text: visible text to find on screen, when there is no element list (2 to 5 words, exactly as shown).
- region: a named area of the app from the regions line (exact name), for apps without accessible controls.
- shortcut: a key combination ("Ctrl+S", "Win+Left"), when the step is a key press.
Never give coordinates. Leave unused target fields as "".

check, how Lumen knows the step is done:
- uia-event: the user invokes, focuses, selects or changes the value of a named control (event invoked, focused, selected, value or window-opened; name and role of that control, value when it matters). Prefer this when the elements list exists.
- window-title: the window title changes to match titleRegex (a short case-insensitive regex), e.g. after opening an app or page.
- keypress: the step is a shortcut; name holds the combo.
- vision: a yes/no question about the screen after the step ("Is the Display settings page open?"). Use this for apps without accessible controls.
- manual: nothing visible changes; the user says "done".
Always fill question with a yes/no question that a screenshot can answer; it is the fallback for every check. Leave other unused check fields as "".

minutes: a realistic estimate for a beginner.

${UNTRUSTED_CONTENT_RULE}`

export interface LessonTurnInput {
  question: string
  /** Foreground window title and process. */
  foreground: string
  app?: string
  /** Skill pack overview + shortcuts excerpt. */
  skillText?: string
  /** Region names from regions.json. */
  regions?: string
  /** Serialized UIA elements list (uia-list serializeElements). */
  elements?: string
  uiaQuality?: 'good' | 'partial' | 'none'
  /** Reading level line for the app (coach readingLevelLineFor); '' / unset = standard. */
  readingLevel?: string
}

/** The generator's user turn: context blocks, then the question verbatim. */
export function lessonTurn(i: LessonTurnInput): string {
  const ctx = [`foreground: ${i.foreground || 'unknown'}`]
  if (i.app) ctx.push(`app: ${i.app}`)
  if (i.uiaQuality) ctx.push(`accessible controls: ${i.uiaQuality}`)
  if (i.regions) ctx.push(`regions: ${i.regions}`)
  if (i.readingLevel) ctx.push(i.readingLevel)
  const blocks = [`<context>\n${ctx.join('\n')}\n</context>`]
  if (i.skillText) blocks.push(`<app_notes>\n${i.skillText}\n</app_notes>`)
  if (i.elements) blocks.push(`<elements>\n${i.elements}\n</elements>`)
  blocks.push(`<question>${i.question}</question>`)
  return blocks.join('\n')
}

// ---- "Why?" during a lesson (07 T20) ----

export const WHY_PROMPT = `The user is following a step-by-step lesson in an app and asked why the current step matters. Answer in at most two short spoken sentences: what the step achieves and how it helps the task. Plain words, no markdown, no lists, never "simply", "just" or "obviously".

${UNTRUSTED_CONTENT_RULE}`

export interface WhyTurnInput {
  app: string
  lessonTitle: string
  step: string
  /** The steps before and after, for context. */
  previous?: string
  next?: string
  appNotes?: string
  /** Reading level line for the app; '' / unset = standard. */
  readingLevel?: string
}

export function whyTurn(i: WhyTurnInput): string {
  const lines = [`app: ${i.app}`, `lesson: ${i.lessonTitle}`]
  if (i.previous) lines.push(`previous step: ${i.previous}`)
  if (i.next) lines.push(`next step: ${i.next}`)
  if (i.readingLevel) lines.push(i.readingLevel)
  const notes = i.appNotes ? `\n<app_notes>\n${i.appNotes}\n</app_notes>` : ''
  return `<context>\n${lines.join('\n')}\n</context>${notes}\n<step>${i.step}</step>`
}
