// Card follow-ups (05 T40): local phrases about the cards just shown. Whole utterances only, so a
// normal request never lands here by accident; the caller only asks while cards from the last
// 15 minutes are in this conversation. Picks: ordinal ("the second one", "the last one"),
// superlative ("the cheapest", "the best rated"), star class ("the 4-star one") or words matched
// against title, subtitle, facts and badges ("the one near the beach", "the Hilton one"). Pure.
import type { Card } from '@shared/cards'
import { ordinal } from '../web/intents'

export type Pick =
  | { by: 'index'; index: number }
  | { by: 'cheapest' }
  | { by: 'priciest' }
  | { by: 'best' }
  | { by: 'worst' }
  | { by: 'stars'; n: number }
  /** all: every word must match (a name said as is: "open Hotel Azur"). */
  | { by: 'words'; words: string; all?: boolean }
  | { by: 'it' }

export type CardIntent =
  | { kind: 'open'; pick: Pick }
  | { kind: 'save'; pick: Pick | 'all' }
  | { kind: 'compare' }
  | { kind: 'show-all' }
  | { kind: 'select'; pick: Pick }
  | { kind: 'more'; pick: Pick; question?: string; onlyFocused?: boolean }
  | { kind: 'refine'; how: 'cheaper' | 'better' | 'like'; pick?: Pick }
  | { kind: 'book'; pick: Pick }

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const POS =
  '(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|eleventh|11th|twelfth|12th|last|number \\d{1,2}|#\\d{1,2})'
const NOUN =
  '(?:one|option|choice|result|card|item|hotel|place|room|apartment|flat|house|villa|hostel|product|deal|offer|flight|train|trip|recipe|restaurant|car)'
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }

/** The pick a phrase names ("the second one", "the cheapest", "the one near the beach"). */
export function parsePick(raw: string): Pick | null {
  const full = clean(raw)
  if (/^(?:it|that|this|that one|this one|that place|this place)$/.test(full)) return { by: 'it' }
  const t = full.replace(/^(?:the|that|this) /, '')
  const pos = new RegExp(`^(${POS})(?: ${NOUN})?$`).exec(t)
  if (pos) {
    const i = ordinal(pos[1].replace(/^#/, ''))
    if (i !== null) return { by: 'index', index: i }
  }
  if (new RegExp(`^(?:cheapest|least expensive|lowest priced|lowest price)(?: ${NOUN})?$`).test(t))
    return { by: 'cheapest' }
  if (new RegExp(`^(?:most expensive|priciest|dearest)(?: ${NOUN})?$`).test(t))
    return { by: 'priciest' }
  if (
    new RegExp(
      `^(?:best|best rated|best-rated|highest rated|top rated|top-rated|best reviewed)(?: ${NOUN})?$`
    ).test(t)
  )
    return { by: 'best' }
  if (new RegExp(`^(?:worst|worst rated|lowest rated)(?: ${NOUN})?$`).test(t))
    return { by: 'worst' }
  const stars = new RegExp(`^(\\d|one|two|three|four|five)[- ]stars?(?: ${NOUN})?$`).exec(t)
  if (stars) return { by: 'stars', n: NUM_WORDS[stars[1]] ?? Number(stars[1]) }
  const one = new RegExp(
    `^${NOUN} (?:that(?:'s| is)? |which is |with |near |by |in |at |on |close to |next to |without )(.{2,60})$`
  ).exec(t)
  if (one) return { by: 'words', words: t.replace(new RegExp(`^${NOUN} `), '') }
  const named = new RegExp(`^(.{2,40}?) ${NOUN}$`).exec(t)
  if (named && !/\b(?:other|another|next|same|any|which|what)\b/.test(named[1]))
    return { by: 'words', words: named[1] }
  return null
}

/** A pick, else the phrase as a card name (all its words must match a card). */
function pickOrName(raw: string): Pick | null {
  const p = parsePick(raw)
  if (p) return p
  const t = clean(raw).replace(/^the /, '')
  return t && t.split(' ').length <= 6 ? { by: 'words', words: t, all: true } : null
}

const PICK_RE = `(?:the |that |this )?(?:${POS}|cheapest|least expensive|most expensive|priciest|best rated|best|highest rated|top rated|worst rated|lowest rated|\\d[- ]stars?|(?:one|two|three|four|five)[- ]stars?)(?: ${NOUN})?`

/** The card intent of an utterance, or null (the normal pipeline runs). */
export function parseCardIntent(text: string): CardIntent | null {
  const t = clean(text)
  if (!t || t.length > 200) return null

  if (
    /^(?:compare (?:them|these|those|all|all of them|the (?:\w+ )?(?:options|results|hotels|places|products))|show (?:them|these|me them) (?:side by side|in a table|as a table)|put them (?:side by side|in a table)|(?:make|show me) a (?:comparison|table))(?: please)?$/.test(
      t
    )
  )
    return { kind: 'compare' }
  if (
    /^(?:show (?:me )?(?:all|all of them|all (?:the )?results|everything|the full list|more results)|open (?:the |all )?results|see all)$/.test(
      t
    )
  )
    return { kind: 'show-all' }

  if (
    /^(?:(?:show me |find (?:me )?|are there |any |look for |search for |get me |i want )?(?:cheaper|less expensive) (?:ones|options|hotels|places|alternatives|ones please|deals)|(?:something|anything|any) cheaper|cheaper(?: please)?|too expensive|(?:find|show me) (?:me )?cheaper)$/.test(
      t
    )
  )
    return { kind: 'refine', how: 'cheaper' }
  if (
    /^(?:(?:show me |find (?:me )?)?(?:better rated|higher rated|better) (?:ones|options|hotels|places)|(?:something|anything) better)$/.test(
      t
    )
  )
    return { kind: 'refine', how: 'better' }
  const like =
    /^(?:(?:find |show me |get me )?(?:more|other|some more) (?:ones |options |places |hotels )?like (.{2,60})|similar (?:ones|options)(?: to (.{2,60}))?|(?:find|show me) (?:something|more) similar)$/.exec(
      t
    )
  if (like) {
    const target = like[1] ?? like[2]
    const pick = target ? parsePick(target) : { by: 'it' as const }
    if (pick) return { kind: 'refine', how: 'like', pick }
  }

  const open =
    /^(?:open|show me|go to|visit|pull up)(?: up)? (.{2,60}?)(?: (?:in|on) (?:my|the) browser| page| website| link)?$/.exec(
      t
    )
  if (open) {
    const pick = pickOrName(open[1])
    if (pick) return { kind: 'open', pick }
  }
  if (
    /^(?:save|keep|bookmark) (?:them|them all|all of them|all|these|the list|the results)(?: (?:to|in) my notes| for later)?$/.test(
      t
    )
  )
    return { kind: 'save', pick: 'all' }
  const save =
    /^(?:save|keep|bookmark|note down|add) (.{2,60}?)(?: (?:to|in) (?:my )?notes| for later)?$/.exec(
      t
    )
  if (save) {
    const pick = pickOrName(save[1])
    if (pick) return { kind: 'save', pick }
  }

  const more =
    /^(?:tell me (?:more )?about|more (?:about|on)|what about|details (?:on|about|for)|describe|what do you know about|more info(?:rmation)? (?:on|about)) (.{2,60})$/.exec(
      t
    )
  if (more) {
    const pick = pickOrName(more[1])
    if (pick) return { kind: 'more', pick }
  }
  // "book the second one" / "book it" / "reserve the cheapest" (T41 runs the booking)
  const book = /^(?:please )?(?:book|reserve|buy|order) (.{2,60}?)(?: for me)?(?: please)?$/.exec(t)
  if (book) {
    const pick = pickOrName(book[1])
    if (pick) return { kind: 'book', pick }
  }
  // "the second one, does it have parking?" / "the one near the beach - is breakfast included"
  const lead =
    /^(.{2,60}?)[,:-]+ ?((?:does|is|has|have|can|what|how|where|when|which|are|do|will|would|any) .{2,140})$/.exec(
      t
    )
  if (lead) {
    const pick = parsePick(lead[1])
    if (pick) return { kind: 'more', pick, question: lead[2] }
  }
  // "does the second one have parking" / "how far is the cheapest one from the beach"
  const mid = new RegExp(
    `^(does|is|has|can|how (?:far|much|big|old) is|where is|what is|what's) (${PICK_RE}) (.{2,120})$`
  ).exec(t)
  if (mid) {
    const pick = parsePick(mid[2])
    if (pick) {
      const verb = mid[1].replace(/ is$/, '').replace(/^what's$/, 'what')
      const q = /^(does|has|can)$/.test(verb)
        ? `${verb} it ${mid[3]}`
        : verb === 'is'
          ? `is it ${mid[3]}`
          : `${verb} is it ${mid[3]}`
      return { kind: 'more', pick, question: q }
    }
  }
  // "does it have parking" right after a card was picked (the turn checks there is one)
  const it =
    /^(does it|is it|has it|how (?:far|much|big|old) is it|where is it|what(?:'s| is) it) (.{2,120})$/.exec(
      t
    )
  if (it)
    return { kind: 'more', pick: { by: 'it' }, question: `${it[1]} ${it[2]}`, onlyFocused: true }
  // "which one is the cheapest" / "which is best rated"
  const which =
    /^which (?:one )?(?:is|has) (?:the )?(cheapest|most expensive|priciest|best rated|best|highest rated|top rated|worst rated|lowest rated)(?: one)?$/.exec(
      t
    )
  if (which) {
    const pick = parsePick(which[1])
    if (pick) return { kind: 'select', pick }
  }
  const bare = parsePick(t)
  if (bare && bare.by !== 'it') return { kind: 'select', pick: bare }
  return null
}

// ---- resolving a pick ----

export type PickResult =
  | { ok: true; card: Card; index: number }
  | { ok: false; reason: 'none' | 'ambiguous' | 'no-price' | 'no-rating'; options?: Card[] }

const STOP = new Set(
  'the a an one that this with near by in at on close to next of and or is it its which has have from for there their'.split(
    ' '
  )
)
const stem = (w: string): string => w.replace(/(?:'s|s)$/, '')

export function haystack(card: Card): string {
  return [
    card.title,
    card.subtitle ?? '',
    ...card.facts.map((f) => `${f.label} ${f.value}`),
    ...(card.badges ?? [])
  ]
    .join(' ')
    .toLowerCase()
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w))
    .map(stem)

const ratio = (c: Card): number | null => (c.rating ? c.rating.value / c.rating.max : null)

/** The card a pick names, or why none fits. `focus`: the card "it" refers to. */
export function resolvePick(pick: Pick, cards: readonly Card[], focus?: string | null): PickResult {
  const at = (i: number): PickResult =>
    cards[i] ? { ok: true, card: cards[i], index: i } : { ok: false, reason: 'none' }
  switch (pick.by) {
    case 'index':
      return at(pick.index < 0 ? cards.length + pick.index : pick.index)
    case 'it': {
      const i = focus ? cards.findIndex((c) => c.id === focus) : -1
      if (i >= 0) return at(i)
      return cards.length === 1 ? at(0) : { ok: false, reason: 'ambiguous', options: [...cards] }
    }
    case 'cheapest':
    case 'priciest': {
      const priced = cards.filter((c) => c.price)
      if (!priced.length) return { ok: false, reason: 'no-price' }
      // Only one currency is compared: the most common one.
      const cur = priced[0].price!.currency
      const same = priced.filter((c) => c.price!.currency === cur)
      const best = same.reduce((a, b) =>
        (
          pick.by === 'cheapest'
            ? b.price!.amount < a.price!.amount
            : b.price!.amount > a.price!.amount
        )
          ? b
          : a
      )
      return at(cards.indexOf(best))
    }
    case 'best':
    case 'worst': {
      const rated = cards.filter((c) => c.rating)
      if (!rated.length) return { ok: false, reason: 'no-rating' }
      const best = rated.reduce((a, b) =>
        (pick.by === 'best' ? ratio(b)! > ratio(a)! : ratio(b)! < ratio(a)!) ? b : a
      )
      return at(cards.indexOf(best))
    }
    case 'stars': {
      const re = new RegExp(
        `(?:\\b${pick.n}[- ]?(?:star|stars|\\*)|${'★'.repeat(pick.n)}(?!★))`,
        'i'
      )
      const hits = cards.filter((c) => re.test(haystack(c)))
      if (hits.length === 1) return at(cards.indexOf(hits[0]))
      if (hits.length > 1) return { ok: false, reason: 'ambiguous', options: hits }
      return { ok: false, reason: 'none' }
    }
    case 'words': {
      const want = words(pick.words)
      if (!want.length) return { ok: false, reason: 'none' }
      const scored = cards.map((c) => {
        const have = new Set(words(haystack(c)))
        return want.filter((w) => have.has(w)).length
      })
      const top = Math.max(...scored)
      if (top <= 0 || (pick.all && top < want.length)) return { ok: false, reason: 'none' }
      const best = cards.filter((_, i) => scored[i] === top)
      return best.length === 1
        ? at(cards.indexOf(best[0]))
        : { ok: false, reason: 'ambiguous', options: best }
    }
  }
}

const ORD = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth'
]
export const ordinalWord = (i: number): string => ORD[i] ?? `number ${i + 1}`

/** "140 euros a night" / "$95". */
export function priceWords(card: Card): string {
  const p = card.price
  if (!p) return ''
  const n = Number.isInteger(p.amount) ? String(p.amount) : p.amount.toFixed(2)
  const name: Record<string, string> = { EUR: 'euros', USD: 'dollars', GBP: 'pounds' }
  return `${n} ${name[p.currency] ?? p.currency}${p.unit ? ` a ${p.unit}` : ''}`
}

/** One or two spoken sentences about a card, from its own data only. */
export function describeCard(card: Card, index: number): string {
  const bits: string[] = []
  const price = priceWords(card)
  if (price) bits.push(price)
  if (card.rating)
    bits.push(
      `rated ${card.rating.value} out of ${card.rating.max}${card.rating.count ? ` from ${card.rating.count} reviews` : ''}`
    )
  const facts = card.facts
    .slice(0, 2)
    .map((f) => `${f.label}: ${f.value}`)
    .join('. ')
  const head = `The ${ordinalWord(index)} one is ${card.title}${card.subtitle ? `, ${card.subtitle}` : ''}`
  return `${head}${bits.length ? `, ${bits.join(', ')}` : ''}.${facts ? ` ${facts}.` : ''}`
}

// ---- nl / de / fr / es basics (T42) ----

/** Ordinals 1–12 per language (regex alternatives, inflections included). */
const FOREIGN_ORD: Record<string, string[]> = {
  nl: [
    'eerste',
    'tweede',
    'derde',
    'vierde',
    'vijfde',
    'zesde',
    'zevende',
    'achtste',
    'negende',
    'tiende',
    'elfde',
    'twaalfde'
  ],
  de: [
    'erste[nmrs]?',
    'zweite[nmrs]?',
    'dritte[nmrs]?',
    'vierte[nmrs]?',
    'f(?:ü|ue)nfte[nmrs]?',
    'sechste[nmrs]?',
    'sie(?:b|bt)te[nmrs]?',
    'achte[nmrs]?',
    'neunte[nmrs]?',
    'zehnte[nmrs]?',
    'elfte[nmrs]?',
    'zw(?:ö|oe)lfte[nmrs]?'
  ],
  fr: [
    'premi(?:er|ère|ere)',
    'deuxi(?:è|e)me|seconde?',
    'troisi(?:è|e)me',
    'quatri(?:è|e)me',
    'cinqui(?:è|e)me',
    'sixi(?:è|e)me',
    'septi(?:è|e)me',
    'huiti(?:è|e)me',
    'neuvi(?:è|e)me',
    'dixi(?:è|e)me',
    'onzi(?:è|e)me',
    'douzi(?:è|e)me'
  ],
  es: [
    'primer[oa]?',
    'segund[oa]',
    'tercer[oa]?',
    'cuart[oa]',
    'quint[oa]',
    'sext[oa]',
    's(?:é|e)ptim[oa]',
    'octav[oa]',
    'noven[oa]',
    'd(?:é|e)cim[oa]',
    'und(?:é|e)cim[oa]',
    'duod(?:é|e)cim[oa]'
  ]
}

const FOREIGN: Record<
  string,
  {
    article: string
    last: string
    cheapest: string
    best: string
    noun: string
    verbs: [RegExp, string][]
  }
> = {
  nl: {
    article: '(?:de|het|die|dat)',
    last: 'laatste',
    cheapest: 'goedkoopste',
    best: 'best beoordeelde|beste',
    noun: '(?:een|optie|hotel|resultaat|product|vlucht|trein|recept|plek)',
    verbs: [
      [/^(?:open|openen|toon|laat (?:me )?zien) /, 'open '],
      [/^(?:bewaar|sla op|opslaan|bewaren) /, 'save '],
      [/^(?:boek|reserveer|koop|bestel) /, 'book '],
      [/^(?:vertel (?:me )?meer over|meer over) /, 'tell me more about ']
    ]
  },
  de: {
    article: '(?:der|die|das|den|dem)',
    last: 'letzte[nmrs]?',
    cheapest: '(?:billigste|g(?:ü|ue)nstigste)[nmrs]?',
    best: '(?:best bewertete|beste)[nmrs]?',
    noun: '(?:option|hotel|ergebnis|produkt|flug|zug|rezept|ort)',
    verbs: [
      [/^(?:(?:ö|oe)ffne|(?:ö|oe)ffnen|zeig(?:e)? mir) /, 'open '],
      [/^(?:speicher(?:e|n)?|merk dir) /, 'save '],
      [/^(?:buche|buchen|reservier(?:e|en)?|kauf(?:e|en)?|bestell(?:e|en)?) /, 'book '],
      [
        /^(?:erz(?:ä|ae)hl (?:mir )?mehr (?:über|ueber)|mehr (?:über|ueber)) /,
        'tell me more about '
      ]
    ]
  },
  fr: {
    article: "(?:le|la|l'|les)",
    last: 'derni(?:er|ère|ere)',
    cheapest: 'moins ch(?:er|ère|ere)',
    best: 'mieux not(?:é|e)e?|meilleure?',
    noun: '(?:option|h(?:ô|o)tel|r(?:é|e)sultat|produit|vol|train|recette|endroit)',
    verbs: [
      [/^(?:ouvre|ouvrir|montre(?:-| )moi) /, 'open '],
      [/^(?:enregistre|garde|sauvegarde) /, 'save '],
      [/^(?:r(?:é|e)serve|ach(?:è|e)te|commande) /, 'book '],
      [/^(?:dis(?:-| )m'en plus sur|parle(?:-| )moi de) /, 'tell me more about ']
    ]
  },
  es: {
    article: '(?:el|la|los|las|lo)',
    last: '(?:ú|u)ltim[oa]',
    cheapest: 'm(?:á|a)s barat[oa]',
    best: 'mejor valorad[oa]|mejor',
    noun: '(?:opci(?:ó|o)n|hotel|resultado|producto|vuelo|tren|receta|sitio|lugar)',
    verbs: [
      [/^(?:abre|abrir|mu(?:é|e)strame) /, 'open '],
      [/^(?:guarda|guardar) /, 'save '],
      [/^(?:reserva|reservar|compra|comprar|pide) /, 'book '],
      [/^(?:cu(?:é|e)ntame m(?:á|a)s sobre|m(?:á|a)s sobre) /, 'tell me more about ']
    ]
  }
}

/**
 * A card follow-up said in Dutch, German, French or Spanish as the English phrase the grammar
 * knows: "de tweede" → "the second one", "open de goedkoopste" → "open the cheapest one",
 * "die zweite" / "le deuxième" / "el segundo". Only picks (ordinal, last, cheapest, best rated)
 * with an optional open / save / book / tell me more verb; null for anything else. Pure.
 */
export function foreignCardPhrase(text: string, lang: string): string | null {
  const l = lang.toLowerCase().split('-')[0]
  const g = FOREIGN[l]
  if (!g) return null
  let t = clean(text).replace(/^(?:graag|bitte|por favor|s'il te plaît|s'il vous plaît) /, '')
  let verb = ''
  for (const [re, en] of g.verbs) {
    if (re.test(t)) {
      verb = en
      t = t.replace(re, '')
      break
    }
  }
  t = t.replace(
    / (?:alstublieft|alsjeblieft|graag|bitte|por favor|s'il te plaît|s'il vous plaît)$/,
    ''
  )
  // `clean` leaves single spaces; French "l'" runs into its word.
  const sep = l === 'fr' ? "(?:(?<=')| )" : ' '
  const head = `^(?:${g.article}${sep})?`
  const tail = `(?: ${g.noun}| one)?$`
  const ord = FOREIGN_ORD[l].findIndex((w) => new RegExp(`${head}(?:${w})${tail}`).test(t))
  let pick: string | null = null
  if (ord >= 0) pick = `the ${ordinalWord(ord)} one`
  else if (new RegExp(`${head}(?:${g.last})${tail}`).test(t)) pick = 'the last one'
  else if (new RegExp(`${head}(?:${g.cheapest})${tail}`).test(t)) pick = 'the cheapest one'
  else if (new RegExp(`${head}(?:${g.best})${tail}`).test(t)) pick = 'the best rated one'
  return pick ? `${verb}${pick}` : null
}
