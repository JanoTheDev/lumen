// "Show me how" wiring (plans 07 T18): the pipeline hands a routed guide request and its
// screen context here; the generated lesson starts in the lesson runner. Null means "no
// lesson" and the pipeline falls back to the old guide reply.
import type { ModelResponse } from '@shared/types'
import { getProvider } from '../ai/providers'
import { parseJsonAs } from '../ai/json'
import { regionsLine, skillContext } from '../ai/skills'
import { log } from '../logger'
import { loadConfig } from '../config'
import { readingLevelAppId, readingLevelLineFor } from '../coach/reading-level'
import type { QueryContext } from '../query/context'
import { elementIndex, serializeElements } from '../query/uia-list'
import { appIdFor, generateLesson, genLessonSchema, type GenerateCall } from './generate'
import { observed } from '../agent-mode/prompts'
import type { HowtoResult } from '../howto'
import { howtoText } from '../howto/tool'
import type { Lesson } from './lesson'
import type { Skill, SkillRegistry } from './registry'

const MAX_TOKENS = 2500

/** The real model call: main role, the screenshot attached, structured output. */
const completeLesson: GenerateCall = async ({ system, user, image, signal }) => {
  const { llm, model, effort } = getProvider('main')
  const res = await llm.complete(
    {
      model,
      system: [{ text: system, cacheable: true }],
      messages: [{ role: 'user', content: user }],
      images: image
        ? [
            {
              base64: image.data,
              mediaType: image.mime === 'image/png' ? 'image/png' : 'image/jpeg'
            }
          ]
        : undefined,
      maxTokens: MAX_TOKENS,
      effort,
      schema: genLessonSchema,
      schemaName: 'lumen_lesson'
    },
    signal
  )
  return res.data ?? parseJsonAs(res.text, genLessonSchema)
}

export interface ShowMeDeps {
  registry: () => SkillRegistry | null
  start: (lesson: Lesson, skill: Skill | null) => void
  complete?: GenerateCall
  /** How-to steps for an app without a pack (05 T36); their UI names become lesson targets. */
  howto?: (question: string, signal: AbortSignal) => Promise<HowtoResult>
}

/** Looked-up steps as app notes for the generator (fenced: web text is data). */
async function howtoNotes(
  deps: ShowMeDeps,
  question: string,
  signal: AbortSignal
): Promise<string | undefined> {
  if (!deps.howto) return undefined
  const r = await deps.howto(question, signal).catch((e: Error) => {
    if (signal.aborted) throw e
    log('fail', `show me how: lookup failed (${e.message})`)
    return null
  })
  if (!r?.steps.length) return undefined
  log('plan', `show me how: ${r.steps.length} looked-up steps (${r.from})`)
  return `${observed('how-to', howtoText(r))}\nUse these UI names as step targets when they are on screen.`
}

/** The reply for a started lesson: handled (no answer card), with a line for history. */
function lessonStartedReply(lesson: Lesson): ModelResponse {
  return {
    mode: 'answer',
    text: `Started a ${lesson.steps.length}-step lesson: ${lesson.title}.`,
    dictated: true
  } as ModelResponse
}

export function makeShowMeHow(deps: ShowMeDeps) {
  return async (
    question: string,
    ctx: QueryContext,
    signal: AbortSignal
  ): Promise<ModelResponse | null> => {
    const t0 = Date.now()
    const pack = ctx.skill
    const frame = ctx.frames[0]
    const elements = frame ? serializeElements(ctx.uia, frame.geometry) : null
    const quality = ctx.uiaQuality ?? pack?.uiaQuality
    const appId = appIdFor(pack, ctx.foreground.process)
    const looked = pack ? undefined : await howtoNotes(deps, question, signal)
    if (signal.aborted) return null
    const lesson = await generateLesson(
      {
        appId,
        question,
        elements: elementIndex(ctx.uia),
        regions: pack?.regions,
        uiaNone: quality === 'none' || !elements,
        turn: {
          question,
          foreground: `${ctx.foreground.title}${ctx.foreground.process ? ` (${ctx.foreground.process})` : ''}`,
          app: pack?.name,
          skillText: pack ? skillContext(pack, question) : looked,
          regions: pack ? regionsLine(pack) : undefined,
          elements: elements?.text,
          uiaQuality: quality,
          readingLevel: readingLevelLineFor(
            loadConfig().helpers,
            readingLevelAppId(pack?.id, ctx.foreground.process)
          )
        },
        image: frame ? { data: frame.data, mime: frame.mime } : undefined
      },
      deps.complete ?? completeLesson,
      signal
    )
    if (signal.aborted) return null
    if (!lesson) {
      log('fail', `show me how: no usable lesson after ${Date.now() - t0}ms`)
      return null
    }
    log(
      'plan',
      `show me how: "${lesson.title}" (${lesson.steps.length} steps, ${appId}) in ${Date.now() - t0}ms`
    )
    deps.start(lesson, deps.registry()?.get(appId) ?? null)
    return lessonStartedReply(lesson)
  }
}
