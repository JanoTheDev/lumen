export type QueryMode = 'answer' | 'action' | 'guide' | 'locate'

export interface QueryIntent {
  mode: QueryMode
  planRequired: boolean
  isContinuation: boolean
}

const ACTION_RE = /\b(open|go to|navigate to|click|type into|compose|send|create|delete|close|switch to|scroll|fill|submit|press|focus|drag|copy|paste|download|upload|write|draft|reply|make|tell)\b/i
const ACTION_RE_GLOBAL = /\b(open|go to|navigate|click|type|compose|send|create|delete|close|scroll|fill|submit|press|focus|drag|copy|paste|download|upload|write|draft|reply|make|tell)\b/gi
const MULTI_INTENT_RE = /\b(and then|and also|after that|then|also)\b|,\s*(then|and)\b/i
// Compose intent always needs a plan: fill recipient + subject + body = multi-field action.
const COMPOSE_INTENT_RE = /\b(write|compose|draft|send|reply(?!\s+to\s+me))\b.{0,30}\b(email|mail|message|dm|tweet|post|slack|text)\b|\b(email|mail|message|dm|tweet|post|text|tell|message)\b.{0,5}\b(my|the)\b/i
// Research intent: user wants information/content found and summarized, not a UI element highlighted.
// Matches "show me [the] positions/jobs/listings/prices/news/reviews for|about|from X" etc.
const RESEARCH_INTENT_RE = /\b(show me|find(?:\s+me)?|look\s+up|search\s+for|get\s+me|check|pull\s+up|look\s+at|pick|choose|which|what(?:'|')?s|what\s+is|compare|recommend)\b.{0,60}\b(positions?|jobs?|internships?|openings?|roles?|listings?|results?|info(?:rmation)?|details?|news|articles?|posts?|prices?|rates?|hours|schedule|reviews?|ratings?|scores?|stats?|stock|weather|forecast|menu|address|phone|contact|holidays?|events?|games?|matches?|flights?|trains?|deals?|offers?|recipes?|restaurants?|shops?|stores?|hotels?|products?|candidates?)\b/i

export function isResearchIntent(prompt: string): boolean {
  return RESEARCH_INTENT_RE.test(prompt.trim())
}
const GUIDE_RE = /^(how (do|can|should) (i|we)|what (are )?the steps|show me how|walk me through|explain how|what steps)\b/i
const QUESTION_RE = /^(what|why|when|where|who|which|is there|are there|tell me|explain|describe)\b/i
const LOCATE_RE = /\b(where is|where are|show me(?! how)|find|highlight|point to|locate|can you show)\b/i
const CONTINUATION_RE = /^(do it|just do it|yes|yes go ahead|go ahead|ok do it|do that|proceed|yes please|yes do it|sure go ahead|yep do it|ok yes)\b\.?$/i

export function classifyQuery(prompt: string): QueryIntent {
  const p = prompt.trim()

  if (CONTINUATION_RE.test(p)) {
    return { mode: 'action', planRequired: false, isContinuation: true }
  }

  // Research intent takes precedence over locate: "show me positions for X" is a research
  // task (search → click → summarize), not a UI-element highlight.
  if (RESEARCH_INTENT_RE.test(p)) {
    return { mode: 'action', planRequired: true, isContinuation: false }
  }

  if (LOCATE_RE.test(p)) {
    return { mode: 'locate', planRequired: false, isContinuation: false }
  }

  if (GUIDE_RE.test(p)) {
    return { mode: 'guide', planRequired: false, isContinuation: false }
  }

  if (ACTION_RE.test(p) || COMPOSE_INTENT_RE.test(p)) {
    // planRequired when multiple verbs, explicit multi-intent, or compose-email intent
    const actionVerbCount = (p.match(ACTION_RE_GLOBAL) ?? []).length
    const planRequired = MULTI_INTENT_RE.test(p) || actionVerbCount > 1 || COMPOSE_INTENT_RE.test(p)
    return { mode: 'action', planRequired, isContinuation: false }
  }

  if (QUESTION_RE.test(p)) {
    return { mode: 'answer', planRequired: false, isContinuation: false }
  }

  return { mode: 'answer', planRequired: false, isContinuation: false }
}
