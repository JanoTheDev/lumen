// Prompt steering the system prompt alone does not achieve reliably. Pure: prompt + context in,
// effective prompt out.
import { classifyQuery, type QueryIntent } from './query-classifier'
import { detectRequestedApp } from '../claude'

// Ordinal list requests (open my 3rd email, 2nd result, etc.) MUST use navigate_url+follow_up.
const ORDINAL_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(st|nd|rd|th))\b.{0,40}(email|mail|message|result|item|tweet|post|notification)/i
// Direct "open/click this/that" requests: the model tends to answer with guide mode. Force action.
const DIRECT_ACTION_RE = /\b(open|click|go to|navigate to|tap|select|press)\s+(this|that|it|the)\b/i
// Locate/show queries: the model ignores the cluster-splitting rule without a hard reminder.
export const LOCATE_RE = /\b(show me|where is|where are|find|highlight|point to|locate|can you show)\b/i

export interface OverrideInput {
  prompt: string
  activeWindow: string
  lowDetail?: boolean
  /** Effective prompt of the previous full turn, for "do it" continuations. */
  lastTaskContext: string | null
}

export interface OverrideResult {
  effectivePrompt: string
  intent: QueryIntent
  requestedApp: { app: string; url: string } | null
  /** Value to remember as lastTaskContext after this turn. */
  nextTaskContext: string | null
}

export function applyOverrides({ prompt, activeWindow, lowDetail, lastTaskContext }: OverrideInput): OverrideResult {
  // Classify intent on the ORIGINAL prompt: override text adds verbs that would inflate
  // the action-verb count and force the planner for single-shot queries.
  const intent = classifyQuery(prompt)

  let effectivePrompt = prompt
  // User named an app (Gmail, LinkedIn, ...) that is not in front: navigate there first.
  const requestedApp = !lowDetail ? detectRequestedApp(prompt, activeWindow) : null
  if (requestedApp) {
    effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: User asked about "${requestedApp.app}" but the active window is "${activeWindow}". You MUST respond with action mode. FIRST action: {"type":"open_url","url":"${requestedApp.url}"}. If further actions are needed after the page loads, put them in follow_up. NEVER return guide mode for an app that isn't currently visible.]`
  }
  if (!lowDetail) {
    if (ORDINAL_RE.test(prompt)) {
      effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: ordinal list request detected. Your response MUST be navigate_url to the list page + follow_up. Do NOT click directly. In follow_up use click_bbox with the exact row bounding box.]`
    } else if (DIRECT_ACTION_RE.test(prompt)) {
      effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: Direct click/open request. You MUST respond with action mode. Use click_bbox with the exact bbox of the target element visible in the screenshot. NEVER use guide mode for this request.]`
    } else if (LOCATE_RE.test(prompt) && intent.mode === 'locate') {
      // Only when the classifier also said locate. Research intents ("show me positions
      // for X") go to the planner and must not take this path.
      effectivePrompt = `${prompt}\n\n[SYSTEM OVERRIDE: This is a highlight/locate request. TWO CASES:\n1. Target content IS visible in current screenshot → respond ONLY with {"mode":"locate","items":[...]}. The target must be the EXACT CONTENT asked about (e.g. actual email rows from a sender) — NOT shortcuts, icons, bookmarks, or launcher tiles that would navigate to that content. CLUSTER RULE: if matching elements appear in 2+ separate groups with unrelated rows between, return ONE item per group.\n2. Target is NOT visible (wrong page, wrong tab, new tab page, or only a shortcut/icon is visible but not the actual content) → use action mode to navigate_url to the correct page, with follow_up:"The page is loaded. Highlight where the user can find: ${prompt}. Respond ONLY with locate mode." NEVER return locate with an empty or zero-size bbox.]`
    }
  }

  // Continuation: user said "do it" after an answer, re-run the original task.
  if (intent.isContinuation && lastTaskContext) {
    effectivePrompt = `${lastTaskContext}\n\n[User confirmed: proceed with action mode. Execute the task now.]`
  }

  // Remember the task for a later continuation (not for low-detail follow-ups).
  const nextTaskContext = !lowDetail && !intent.isContinuation ? effectivePrompt : lastTaskContext

  return { effectivePrompt, intent, requestedApp, nextTaskContext }
}
