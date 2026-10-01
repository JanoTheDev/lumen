// Independent answer questions from router.parallelSplit, run at the same time. Each one
// gets a child CancelScope (cancelling the turn cancels them all; one failing cancels the
// rest) and its own history slot. Results, the merged answer and the history entries
// always follow the original question order, whatever order the calls finish in.
import type { ModelResponse } from '@shared/types'
import type { CancelScope } from './cancel'
import { addToHistory } from '../ai/history'

export interface SubResult {
  query: string
  response: ModelResponse
}

export async function runParallelSplit(
  queries: string[],
  scope: CancelScope,
  runOne: (query: string, child: CancelScope) => Promise<ModelResponse>
): Promise<SubResult[]> {
  const children = queries.map(() => scope.child())
  try {
    const responses = await Promise.all(queries.map((q, i) => runOne(q, children[i])))
    scope.throwIfCancelled()
    return queries.map((query, i) => ({ query, response: responses[i] }))
  } catch (e) {
    for (const c of children) c.cancel()
    throw e
  }
}

function spokenOf(r: ModelResponse): string {
  if (r.mode === 'answer') return (r.spoken ?? r.text).trim()
  if (r.mode === 'action') return r.summary ?? ''
  return ''
}

function textOf(r: ModelResponse): string {
  if (r.mode === 'answer') return r.text.trim()
  return spokenOf(r)
}

/** One answer card: each question in bold with its answer, in the original order. */
export function mergeSplit(results: SubResult[]): ModelResponse {
  return {
    mode: 'answer',
    text: results.map((r) => `**${r.query}**\n${textOf(r.response)}`).join('\n\n'),
    spoken: results
      .map((r) => spokenOf(r.response))
      .filter(Boolean)
      .join(' ')
  }
}

/** One history exchange per sub-question, in the original order. */
export function recordSplitHistory(
  results: SubResult[],
  summarize: (r: ModelResponse) => string,
  add: (prompt: string, summary: string) => void = addToHistory
): void {
  for (const r of results) add(r.query, summarize(r.response))
}
