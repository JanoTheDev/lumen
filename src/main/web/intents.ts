// Local phrases for "read the web with me" (05 T30–T34). Whole-utterance matches only, so a
// normal question never lands here by accident; follow-ups ("open the second one", "is it
// biased") match only while a page or news list from the last few minutes is in context. Pure.

export type WebIntent =
  | { kind: 'summarize' }
  | { kind: 'ask'; question: string }
  | { kind: 'news'; query?: string; topic?: string }
  | { kind: 'story'; index: number | 'current' }
  | { kind: 'open'; which: SourcePick }
  | { kind: 'save' }

/** Which source(s) to open: all, the nth (0-based, -1 = last) or one by site name. */
export type SourcePick = { all: true } | { index: number } | { name: string }

export interface IntentContext {
  /** A page summary from the last few minutes. */
  page: boolean
  /** A news list from the last few minutes. */
  news: boolean
  /** The foreground window is a browser. */
  browser: boolean
}

const ORDINALS: Record<string, number> = {
  first: 0,
  '1st': 0,
  one: 0,
  second: 1,
  '2nd': 1,
  two: 1,
  third: 2,
  '3rd': 2,
  three: 2,
  fourth: 3,
  '4th': 3,
  four: 3,
  fifth: 4,
  '5th': 4,
  five: 4,
  sixth: 5,
  '6th': 5,
  six: 5,
  seventh: 6,
  '7th': 6,
  seven: 6,
  eighth: 7,
  '8th': 7,
  eight: 7,
  ninth: 8,
  '9th': 8,
  nine: 8,
  tenth: 9,
  '10th': 9,
  ten: 9,
  last: -1
}

/** "second" / "2nd" / "2" / "number 2" / "last" → 0-based index (-1 = last); else null. */
export function ordinal(word: string): number | null {
  const w = word
    .trim()
    .toLowerCase()
    .replace(/^(number|no\.?|#)\s*/, '')
  if (w in ORDINALS) return ORDINALS[w]
  const n = /^(\d{1,2})$/.exec(w)
  return n && Number(n[1]) >= 1 ? Number(n[1]) - 1 : null
}

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const ITEM = '(?:one|story|article|link|source|item|headline)'
const POS =
  '(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|number \\d{1,2}|#?\\d{1,2})'

const SUMMARIZE = [
  /^(?:please )?(?:summari[sz]e|sum up|recap)(?: (?:this|that|it|the (?:page|article|story|post)|this (?:page|article|story|post|tab)|what i'?m (?:reading|looking at)))?(?: for me)?(?: please)?$/,
  /^(?:give me )?(?:a |the )?(?:tl ?;? ?dr|tldr|summary|gist|short version)(?: of (?:this|that|it|the|this) ?(?:page|article|story|post)?)?(?: please)?$/,
  /^what(?:'s| is) (?:this|the) (?:page|article|story|post|tab)(?: (?:about|saying))?$/,
  /^what(?:'s| is) this (?:about|saying)$/,
  /^explain (?:this|the) (?:page|article|story|post)(?: to me)?$/,
  /^(?:can you )?(?:read|look at) (?:this|the) (?:page|article) and (?:summari[sz]e|sum it up|tell me what it says)$/
]

const NEWS = [
  /^(?:what(?:'s| is| are) )?(?:the )?(?:top |latest |today's |main |big )*(?:news|headlines|stories)(?: (?:today|right now|this morning|this evening|for today))?$/,
  /^(?:tell me |give me |read me )(?:the )?(?:top |latest |today's |main )*(?:news|headlines)(?: (?:today|right now))?$/,
  /^what(?:'s| is) (?:in the news|new|going on|happening)(?: (?:today|right now|in the world))?$/
]

const TOPIC_NEWS =
  /^(?:what(?:'s| is) )?(?:happening|new|going on|the (?:latest|news))? ?in (tech|technology|science|sports?|business|politics|the world|world news)(?: (?:today|right now|news))?$/
const TOPIC_PREFIX =
  /^(?:the )?(?:latest |top |today's )?(tech|technology|science|sports?|business|world) news(?: today)?$/
const NEWS_ABOUT =
  /^(?:(?:what(?:'s| is) the )?(?:latest )?news|any news|what(?:'s| is) new|(?:the )?latest|headlines|what are people saying|what(?:'s| is) happening) (?:about|on|with|regarding) (.{2,80})$/

const TOPICS: Record<string, string> = {
  tech: 'tech',
  technology: 'tech',
  science: 'tech',
  sport: 'sports',
  sports: 'sports',
  business: 'business',
  politics: 'world',
  'the world': 'world',
  'world news': 'world',
  world: 'world'
}

function matchOpen(t: string): SourcePick | null {
  if (
    /^(?:open|show me) (?:all (?:the |of the )?(?:sources|links|stories)|the sources|sources|all of them)$/.test(
      t
    )
  )
    return { all: true }
  if (/^(?:show me )?where (?:that|this|it) (?:came|comes) from$/.test(t)) return { index: 0 }
  if (/^open (?:the |that )?(?:source|link|article)$/.test(t)) return { index: 0 }
  if (/^open (?:it|that|this)(?: (?:up|in (?:my|the) browser))?$/.test(t)) return { index: 0 }
  const pos = new RegExp(`^(?:open|show me|show) (?:the )?${POS} ${ITEM}$`).exec(t)
  if (pos) {
    const i = ordinal(pos[1])
    if (i !== null) return { index: i }
  }
  const num = /^open (?:source|link|story|number) (\d{1,2})$/.exec(t)
  if (num) return { index: Number(num[1]) - 1 }
  const named = new RegExp(`^open (?:the )?(.{2,40}?) ${ITEM}$`).exec(t)
  if (named && ordinal(named[1]) === null) return { name: named[1] }
  return null
}

function matchStory(t: string): number | null {
  const m = new RegExp(
    `^(?:tell me (?:more )?about|more (?:about|on)|what about|read me|explain|go deeper (?:on|into)) (?:the )?${POS} ${ITEM}$`
  ).exec(t)
  return m ? ordinal(m[1]) : null
}

const ASK_PAGE = [
  /^what does (?:it|this|the (?:page|article|story|post)|this (?:page|article|story|post)) say (?:about|on) (.{2,120})$/,
  /^does (?:it|this|the (?:page|article)) (?:say|mention|talk about) (.{2,120})$/,
  /^(?:is|was) (?:it|this|the (?:page|article|story)|this (?:article|story)) (biased|reliable|trustworthy|accurate|an ad|sponsored|opinion|satire|true)$/,
  /^(?:read|tell) me the (conclusion|ending|end|intro|introduction|main points?|key points?|takeaways?)$/,
  /^explain (?:it|this|that) (like i'?m (?:\d{1,2}|five|a kid|a child)|in simple (?:words|terms)|simpler|more simply)$/,
  /^(?:who wrote (?:it|this)|when was (?:it|this) (?:written|published)|what(?:'s| is) the (?:main point|bottom line|source))$/
]

/** The web intent of an utterance, or null when it is not one (the normal pipeline runs). */
export function parseWebIntent(text: string, ctx: IntentContext): WebIntent | null {
  const t = clean(text)
  if (!t || t.length > 200) return null
  const hasCtx = ctx.page || ctx.news

  if (SUMMARIZE.some((re) => re.test(t))) {
    // "summarize it" / "recap" without a page in front is someone else's (dictation, lessons).
    const bare =
      /^(?:please )?(?:summari[sz]e|sum up|recap)(?: (?:this|that|it))?(?: please)?$/.test(t)
    if (bare && !ctx.browser && !ctx.page) return null
    return { kind: 'summarize' }
  }

  if (NEWS.some((re) => re.test(t))) return { kind: 'news' }
  const topic = TOPIC_NEWS.exec(t) ?? TOPIC_PREFIX.exec(t)
  if (topic) return { kind: 'news', topic: TOPICS[topic[1]] ?? topic[1] }
  const about = NEWS_ABOUT.exec(t)
  if (about) {
    const q = about[1].trim()
    // "what are people saying about it" follows the current story.
    if (/^(?:it|that|this|that story|this story)$/.test(q))
      return hasCtx ? { kind: 'story', index: 'current' } : null
    return { kind: 'news', query: q }
  }

  if (
    /^save (?:this|that|it|the summary|the (?:page|article|story)) (?:to|in) (?:my )?notes?$/.test(
      t
    ) ||
    /^add (?:this|that|it) to (?:my )?notes$/.test(t)
  )
    return hasCtx ? { kind: 'save' } : null

  if (!hasCtx) {
    // Asking about the page in front without a summary yet: read it first.
    if (ctx.browser && ASK_PAGE.some((re) => re.test(t)))
      return { kind: 'ask', question: text.trim() }
    return null
  }

  const open = matchOpen(t)
  if (open) return { kind: 'open', which: open }
  if (ctx.news) {
    const story = matchStory(t)
    if (story !== null) return { kind: 'story', index: story }
  }
  if (ctx.page && ASK_PAGE.some((re) => re.test(t))) return { kind: 'ask', question: text.trim() }
  return null
}
