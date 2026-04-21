export type QueryMode = 'answer' | 'action' | 'guide' | 'locate'

export interface QueryIntent {
  mode: QueryMode
  planRequired: boolean
  isContinuation: boolean
}

const ACTION_RE = /\b(open|go to|navigate to|click|type into|compose|send|create|delete|close|switch to|scroll|fill|submit|press|focus|drag|copy|paste|download|upload)\b/i
const ACTION_RE_GLOBAL = /\b(open|go to|navigate|click|type|compose|send|create|delete|close|scroll|fill|submit|press|focus|drag|copy|paste|download|upload)\b/gi
const MULTI_INTENT_RE = /\b(and then|and also|after that|then|also)\b|,\s*(then|and)\b/i
const GUIDE_RE = /^(how (do|can|should) (i|we)|what (are )?the steps|show me how|walk me through|explain how|what steps)\b/i
const QUESTION_RE = /^(what|why|when|where|who|which|is there|are there|tell me|explain|describe)\b/i
const LOCATE_RE = /\b(where is|where are|show me(?! how)|find|highlight|point to|locate|can you show)\b/i
const CONTINUATION_RE = /^(do it|just do it|yes|yes go ahead|go ahead|ok do it|do that|proceed|yes please|yes do it|sure go ahead|yep do it|ok yes)\b\.?$/i

export function classifyQuery(prompt: string): QueryIntent {
  const p = prompt.trim()

  if (CONTINUATION_RE.test(p)) {
    return { mode: 'action', planRequired: false, isContinuation: true }
  }

  if (LOCATE_RE.test(p)) {
    return { mode: 'locate', planRequired: false, isContinuation: false }
  }

  if (GUIDE_RE.test(p)) {
    return { mode: 'guide', planRequired: false, isContinuation: false }
  }

  if (ACTION_RE.test(p)) {
    // planRequired when multiple distinct action verbs exist ("open X and compose Y")
    const actionVerbCount = (p.match(ACTION_RE_GLOBAL) ?? []).length
    const planRequired = MULTI_INTENT_RE.test(p) || actionVerbCount > 1
    return { mode: 'action', planRequired, isContinuation: false }
  }

  if (QUESTION_RE.test(p)) {
    return { mode: 'answer', planRequired: false, isContinuation: false }
  }

  return { mode: 'answer', planRequired: false, isContinuation: false }
}
