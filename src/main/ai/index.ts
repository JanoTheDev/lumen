// Model calls for the query pipeline. Provider and model come from the role router.
import type { ModelResponse } from '@shared/types'
import { currentContext, type QueryContext } from '../query/context'
import { serializeElements } from '../query/uia-list'
import { log } from '../logger'
import { bus } from '../bus'
import { currentFrame } from '../actions/coords'
import { historyMessages } from './history'
import { estimateTokens, logPrefixSize, systemBlocks, userTurn } from './prompts/assemble'
import { parseReplyText, replySchema, toModelResponse, type Reply } from './schema'
import { streamReply } from './stream-reply'
import { appNameOf, matchSkill, regionsLine, skillContext } from './skills'
import { memoryContextFor } from './memory/runtime'
import {
  LlmError,
  REFUSAL_MESSAGE,
  getProvider,
  onUsage,
  retryBudget,
  warmupProviders,
  type StructuredRequest
} from './providers'
import { noteAnswerModel, recordUsage } from './cost'

export type {
  Action,
  Confidence,
  GuideStep as Step,
  ModelResponse as ClaudeResponse
} from '@shared/types'

export interface CallOptions {
  lowDetail?: boolean // use low-res image + fewer tokens (for follow_up row enumeration)
  signal?: AbortSignal
  /** Turn the streamed spoken text belongs to; without it nothing is published. */
  turnId?: string
  /** Mode from the router; the model uses it instead of re-deciding. */
  routedMode?: string
  /** App the user wants that is not in front (router appSwitch). */
  targetApp?: { name: string; url?: string }
  /** Screen context of this call; defaults to the latest capture when its image is the one sent. */
  context?: QueryContext
  /** false: no conversation history (plan, research and follow-up step calls). */
  history?: boolean
}

function contextFor(screenshot: string | null, opts: CallOptions): QueryContext | undefined {
  if (opts.context) return opts.context
  const latest = currentContext()
  return screenshot && latest?.screenshot === screenshot ? latest : undefined
}

/**
 * One main-model call. The reply streams so the spoken answer is published sentence by
 * sentence (see stream-reply.ts); the full JSON is parsed once the stream ends.
 */
export async function callModel(
  prompt: string,
  screenshotBase64: string | null,
  activeWindow: string,
  opts: CallOptions = {}
): Promise<ModelResponse> {
  const ctx = contextFor(screenshotBase64, opts)
  const geometry = ctx?.frames[0]?.geometry ?? currentFrame()
  const { imgW, imgH } = geometry
  const elements = screenshotBase64 ? serializeElements(ctx?.uia, geometry) : null
  if (elements)
    log(
      'plan',
      `uia list: ${elements.count} nodes ~${elements.tokens} tokens${elements.truncated ? ' (truncated)' : ''}`
    )
  const skill = ctx?.skill ?? matchSkill({ title: activeWindow })
  const skillText = skill ? skillContext(skill, prompt) : ''
  if (skill) log('plan', `skill ${skill.id}: ~${estimateTokens(skillText)} tokens`)
  // Memory goes with the user's own request only, not with plan/research/follow-up steps.
  const withConversation = opts.history !== false
  const memoryText = withConversation
    ? memoryContextFor(prompt, skill?.name ?? appNameOf(ctx?.foreground.process))
    : ''
  if (memoryText) log('plan', `memory: ~${estimateTokens(memoryText)} tokens`)
  const { llm, model, effort } = getProvider('main')
  logPrefixSize()
  const req: StructuredRequest<Reply> = {
    model,
    system: systemBlocks(),
    messages: [
      ...(withConversation ? historyMessages() : []),
      {
        role: 'user',
        content: userTurn({
          prompt,
          activeWindow,
          frame: screenshotBase64 ? { w: imgW, h: imgH } : null,
          routedMode: opts.routedMode,
          targetApp: opts.targetApp,
          elements: elements?.text,
          marks: screenshotBase64 ? ctx?.marks?.length : undefined,
          skill: skill ? { name: skill.name, text: skillText } : undefined,
          memory: memoryText || undefined,
          regions: skill && screenshotBase64 ? regionsLine(skill) : undefined
        })
      }
    ],
    images: screenshotBase64
      ? [{ base64: screenshotBase64, detail: opts.lowDetail ? 'low' : 'high' }]
      : [],
    maxTokens: opts.lowDetail ? 2048 : 4096,
    effort,
    schema: replySchema,
    schemaName: 'lumen_reply'
  }
  try {
    let res = await streamReply(llm, req, opts.signal, opts.turnId)
    if (res.stopReason === 'max_tokens') {
      const budget = retryBudget(req.maxTokens)
      if (budget === null) throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
      console.log(`[fail] truncated streamed reply, retrying with max_tokens ${budget}`)
      res = await llm.complete({ ...req, maxTokens: budget }, opts.signal)
    }
    noteAnswerModel(res.model)
    return toModelResponse(parseReplyText(res.text), activeWindow)
  } catch (e) {
    if (e instanceof LlmError && e.code === 'E_REFUSED')
      return { mode: 'answer', text: REFUSAL_MESSAGE }
    throw e
  }
}

/** @deprecated Use callModel. */
export const callClaude = callModel

// Warm the SDK connection pools at startup (after .env is loaded) and whenever the user starts
// speaking, so the request after the transcript skips the TLS handshake.
onUsage(recordUsage)
if (process.versions.electron) setImmediate(() => warmupProviders())
bus.on('voice.started', () => warmupProviders())
