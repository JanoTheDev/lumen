// Streams one structured reply. The `spoken` field is published while it arrives: every new
// piece as `query.delta`, every complete sentence as `speech.say-chunk`, so speech can start
// on the first sentence before the rest of the JSON (markdown, targets) has been written.
import { bus } from '../bus'
import { readPartialString } from './json'
import { SentenceSplitter } from './sentences'
import type { ChatResult, LlmProvider, StructuredRequest } from './providers/types'

function abortError(): Error {
  const e = new Error('The request was cancelled.')
  e.name = 'AbortError'
  return e
}

export async function streamReply(
  llm: LlmProvider,
  req: StructuredRequest<unknown>,
  signal?: AbortSignal,
  turnId?: string
): Promise<ChatResult> {
  let buf = ''
  let sent = 0
  let spokenDone = !turnId
  let index = 0
  let result: ChatResult | null = null
  const splitter = new SentenceSplitter()
  const say = (text: string): void => {
    if (turnId) bus.emit({ type: 'speech.say-chunk', turnId, text, index: index++ })
  }

  for await (const chunk of llm.stream(req, signal)) {
    if (chunk.type === 'done') {
      result = chunk.result
      continue
    }
    buf += chunk.text
    if (spokenDone || !turnId) continue
    const spoken = readPartialString(buf, 'spoken')
    if (!spoken) continue
    const delta = spoken.text.slice(sent)
    if (delta) {
      sent = spoken.text.length
      bus.emit({ type: 'query.delta', turnId, delta })
      splitter.push(delta).forEach(say)
    }
    if (spoken.done) {
      spokenDone = true
      const rest = splitter.flush()
      if (rest) say(rest)
    }
  }

  if (signal?.aborted) throw abortError()
  if (!result) throw new Error('The reply stream ended early.')
  return result
}
