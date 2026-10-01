// Fixed status vocabulary (06 T18). The same situation is always said the same way, and simple
// mode swaps in shorter, plainer words. New a11y status text goes here, not inline.

export type PhraseId =
  | 'done'
  | 'failed'
  | 'blocked'
  | 'unsupported'
  | 'looking'
  | 'reading'
  | 'paused'
  | 'resumed'
  | 'stopped-reading'
  | 'end-of-page'
  | 'nothing-to-read'
  | 'no-page-text'
  | 'not-reading'
  | 'voice-off'
  | 'yielded'

const STANDARD: Record<PhraseId, string> = {
  done: 'Done',
  failed: 'That did not work',
  blocked: 'Blocked for safety',
  unsupported: 'The helper app cannot do that yet',
  looking: 'Looking at the screen',
  reading: 'Reading. Say "pause", "next" or "stop"',
  paused: 'Paused. Say "continue" to go on',
  resumed: 'Reading',
  'stopped-reading': 'Stopped reading',
  'end-of-page': 'That was the end',
  'nothing-to-read': 'I could not find text to read. Select some text first',
  'no-page-text': 'I could not read this page',
  'not-reading': 'Nothing is being read',
  'voice-off': 'Spoken replies are off, so here it is as text',
  yielded: '{who} handles that. Say "Lumen" first to have Lumen do it'
}

const SIMPLE: Record<PhraseId, string> = {
  done: 'Done',
  failed: 'That did not work',
  blocked: 'Not allowed',
  unsupported: 'I cannot do that',
  looking: 'Looking',
  reading: 'Reading. Say "stop" to stop',
  paused: 'Paused. Say "continue"',
  resumed: 'Reading',
  'stopped-reading': 'Stopped',
  'end-of-page': 'The end',
  'nothing-to-read': 'Nothing to read. Select some text first',
  'no-page-text': 'I cannot read this page',
  'not-reading': 'Nothing to stop',
  'voice-off': 'Here it is as text',
  yielded: '{who} did that. Say "Lumen" first for me'
}

/** The phrase for `id`; `{name}` placeholders are filled from `vars`. */
export function phrase(id: PhraseId, simple = false, vars: Record<string, string> = {}): string {
  const text = (simple ? SIMPLE : STANDARD)[id]
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
}

/**
 * The answer-style line for the model's user turn when simple mode is on (request to 05:
 * `style: "plain"`). Kept here so the wording matches the rest of simple mode.
 */
export const PLAIN_STYLE_LINE =
  'style: plain. Short sentences (at most 15 words), everyday words, no idioms, jargon or metaphors, one idea per sentence, about a 6th-grade reading level. Give one step at a time.'

/** `style: "plain"` while simple mode is on. */
export function answerStyle(cfg: { a11y: { simpleMode: boolean } }): 'plain' | undefined {
  return cfg.a11y.simpleMode ? 'plain' : undefined
}
