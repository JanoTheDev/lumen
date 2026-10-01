// Spoken conversation/memory commands, matched as whole utterances by the router prefilter
// until 06's grammar takes them over. Each one is handled locally and confirmed through the
// answer path (card + speech); none of them reaches the model.
import type { ModelResponse } from '@shared/types'
import { normalizeUtterance } from '../guides/voice-nav'
import { history } from '../ai/history'
import { log } from '../logger'

export type MemoryCommand = { kind: 'new-topic' } | { kind: 'forget-last' }

const NEW_TOPIC_RE = /^(new topic|start over|change (the )?subject|lets start over)$/
const FORGET_LAST_RE = /^(forget (that|what i (just )?said)|scratch that)$/

/** The command an utterance is, or null. Only whole, short utterances match. */
export function matchMemoryCommand(utterance: string): MemoryCommand | null {
  const text = normalizeUtterance(utterance)
  if (NEW_TOPIC_RE.test(text)) return { kind: 'new-topic' }
  if (FORGET_LAST_RE.test(text)) return { kind: 'forget-last' }
  return null
}

export const spokenAnswer = (text: string): Extract<ModelResponse, { mode: 'answer' }> => ({
  mode: 'answer',
  text,
  spoken: text
})

/** Runs a command and returns the reply for the renderer. */
export function handleMemoryCommand(cmd: MemoryCommand): ModelResponse {
  log('plan', `memory command: ${cmd.kind}`)
  switch (cmd.kind) {
    case 'new-topic':
      history.clear()
      return spokenAnswer('Okay, new topic.')
    case 'forget-last':
      return spokenAnswer(
        history.dropLast() ? 'Okay, I forgot that.' : 'There was nothing to forget.'
      )
  }
}
