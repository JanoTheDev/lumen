// Calling buddies by voice (08 T52): "Inbox Buddy, what's new?", "hey Price Buddy …", "ask
// <name> to …", "have the Downloads Buddy tidy up now", "run <name> now" run that buddy with the
// rest of the words; "stop / pause / turn off / turn on <name>", "pause all buddies", "resume
// buddies", "what are my buddies doing", "what did <name> find". Names match with or without
// "buddy" and "the", any case, and with one wrong letter per word (speech recognition). A name
// that does not end in "Buddy" (or a bare short name) is a call only when addressed: a comma
// after it, "hey" in front, or "ask / tell <name> to …", so plain requests ("send email to Bob")
// never become buddy calls by accident. The grammar is pure; BuddyVoice adds the
// "which one?" follow-up and the spoken replies through injected ports.
import type { Buddy, BuddyRunSummary, BuddySummary } from '@shared/buddies'
import type { ModelResponse } from '@shared/types'

export interface BuddyRef {
  id: string
  name: string
}

export type BuddyCommand =
  /** Run it now with these words ('' = do its job). */
  | { kind: 'call'; id: string; utterance: string }
  /** Cancel its running tasks. */
  | { kind: 'stop'; id: string }
  | { kind: 'stop-all' }
  /** Turn it on or off (schedules and calls). */
  | { kind: 'enable'; id: string; on: boolean }
  | { kind: 'pause-all' }
  | { kind: 'resume-all' }
  | { kind: 'status' }
  /** Its last result. */
  | { kind: 'last'; id: string }
  /** Several buddies fit the name: ask which (the command waits with an empty id). */
  | { kind: 'ambiguous'; ids: string[]; command: Exclude<BuddyCommand, { kind: 'ambiguous' }> }
  /** "stop Foo Buddy" when there is no Foo Buddy. */
  | { kind: 'unknown'; name: string }

interface Tok {
  w: string
  start: number
  end: number
}

const BUDDY_WORDS = new Set(['buddy', 'buddie', 'buddies', 'budy', 'body', 'bud', 'buddys'])
const FILLER = new Set(['now', 'please', 'again', 'task', 'run', 'tasks', 'right'])

function tokens(text: string): Tok[] {
  const out: Tok[] = []
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)) {
    const w = m[0]
      .toLowerCase()
      .replace(/['’]s$/, '')
      .replace(/['’]/g, '')
    out.push({ w, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return out
}

/** Edit distance, stopping early past `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** 0 = the same word, 1 = close enough (a misheard letter), -1 = different. */
function wordMatch(heard: string, name: string): 0 | 1 | -1 {
  if (heard === name) return 0
  if (BUDDY_WORDS.has(name) && BUDDY_WORDS.has(heard)) return 1
  if (name.length >= 4 && /^\p{L}+$/u.test(name)) {
    const d = editDistance(heard, name, 2)
    if (d <= 1 || (name.length >= 8 && d <= 2)) return 1
  }
  return -1
}

interface Alias {
  id: string
  words: string[]
  /**
   * The whole name ending in "buddy": safe after a verb or without a comma. Any other name
   * ("Inbox" for Inbox Buddy, "Send Email") needs a comma, "hey" or "ask / tell … to".
   */
  strong: boolean
  /** The whole name with "buddy" in it or of two or more words: enough for "stop <name>". */
  whole: boolean
}

function aliases(list: readonly BuddyRef[]): Alias[] {
  const out: Alias[] = []
  for (const b of list) {
    const words = tokens(b.name).map((t) => t.w)
    if (!words.length) continue
    const strong = BUDDY_WORDS.has(words[words.length - 1])
    const whole = strong || words.some((w) => BUDDY_WORDS.has(w)) || words.length >= 2
    out.push({ id: b.id, words, strong, whole })
    const short = words.filter((w) => !BUDDY_WORDS.has(w))
    if (short.length && short.length < words.length)
      out.push({ id: b.id, words: short, strong: false, whole: false })
  }
  return out
}

interface NameHit {
  ids: string[]
  /** Index of the first token after the name. */
  next: number
  strong: boolean
  whole: boolean
}

/** The buddy name at token `i` (a leading "the" skipped); null when none. */
function nameAt(toks: Tok[], i: number, all: Alias[]): NameHit | null {
  if (toks[i]?.w === 'the') i++
  let best: {
    len: number
    fuzzy: number
    ids: Set<string>
    strong: boolean
    whole: boolean
  } | null = null
  for (const a of all) {
    if (i + a.words.length > toks.length) continue
    let fuzzy = 0
    let ok = true
    for (let k = 0; k < a.words.length; k++) {
      const m = wordMatch(toks[i + k].w, a.words[k])
      if (m < 0) {
        ok = false
        break
      }
      fuzzy += m
    }
    if (!ok) continue
    const len = a.words.length
    if (!best || len > best.len || (len === best.len && fuzzy < best.fuzzy))
      best = { len, fuzzy, ids: new Set([a.id]), strong: a.strong, whole: a.whole }
    else if (len === best.len && fuzzy === best.fuzzy) {
      best.ids.add(a.id)
      best.strong ||= a.strong
      best.whole ||= a.whole
    }
  }
  return best
    ? { ids: [...best.ids], next: i + best.len, strong: best.strong, whole: best.whole }
    : null
}

/** The original text after token `i` (punctuation in front trimmed). */
function restFrom(text: string, toks: Tok[], i: number): string {
  if (i >= toks.length) return ''
  return text
    .slice(toks[i].start)
    .trim()
    .replace(/^[\s,:;.!?-]+/, '')
}

/** A comma, colon or the end right after the name (a vocative). */
function separated(text: string, toks: Tok[], next: number): boolean {
  const end = toks[next - 1].end
  const between = text.slice(end, next < toks.length ? toks[next].start : text.length)
  return next >= toks.length || /[,:;!?.]/.test(between)
}

const NOT_A_NAME = new Set(['a', 'an', 'my', 'your', 'this', 'that', 'good', 'nice', 'it', 'you'])

/** "stop Foo Buddy": the words up to a "buddy" word close after `i`, for "no such buddy". */
function namedBuddyWords(toks: Tok[], i: number): string | null {
  if (toks[i]?.w === 'the') i++
  if (!toks[i] || NOT_A_NAME.has(toks[i].w)) return null
  for (let k = i; k < Math.min(toks.length, i + 3); k++) {
    if (BUDDY_WORDS.has(toks[k].w)) {
      if (k === i) return null
      return toks
        .slice(i, k + 1)
        .map((t) => t.w)
        .join(' ')
    }
  }
  return null
}

const onlyFiller = (toks: Tok[], from: number): boolean =>
  toks.slice(from).every((t) => FILLER.has(t.w))

type Built = Exclude<BuddyCommand, { kind: 'ambiguous' } | { kind: 'unknown' }>

function pick(hit: NameHit, make: (id: string) => Built): BuddyCommand {
  if (hit.ids.length === 1) return make(hit.ids[0])
  return { kind: 'ambiguous', ids: hit.ids, command: make('') }
}

const STATUS_RE =
  /^(?:what|whats|whatre) (?:are |is )?(?:my |the |all )?(?:my )?buddies (?:doing|up to|working on)(?: now| right now)?$|^how are (?:my |the )?buddies(?: doing)?$|^(?:list|show)(?: me)? (?:all )?(?:my |the )?buddies$|^what buddies do i have$|^buddy status$/
const PAUSE_ALL_RE =
  /^(?:pause|disable|mute|turn off|switch off) (?:all )?(?:of )?(?:my |the )?buddies$|^turn (?:all )?(?:my |the )?buddies off$/
const RESUME_ALL_RE =
  /^(?:resume|unpause|enable|turn on|switch on|wake up) (?:all )?(?:of )?(?:my |the )?buddies$|^turn (?:all )?(?:my |the )?buddies (?:back )?on$/
const STOP_ALL_RE = /^(?:stop|cancel|halt) (?:all )?(?:of )?(?:my |the )?buddies(?: now)?$/

const STOP = new Set(['stop', 'cancel', 'halt', 'abort'])
const OFF = new Set(['pause', 'disable'])
const ON = new Set(['resume', 'unpause', 'enable'])
const ADDRESS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo'])
/** A greeting that makes even a short name an address ("hey Inbox …"). */
const HEY = new Set(['hey', 'hi', 'hello'])
const LAST_VERBS = new Set(['find', 'say', 'report', 'get', 'do', 'see', 'learn', 'come', 'notice'])

/** The buddy command in these words, or null when they are not one. */
export function parseBuddyCommand(text: string, list: readonly BuddyRef[]): BuddyCommand | null {
  const toks = tokens(text)
  if (!toks.length) return null
  const joined = toks.map((t) => t.w).join(' ')
  if (STATUS_RE.test(joined)) return { kind: 'status' }
  if (PAUSE_ALL_RE.test(joined)) return { kind: 'pause-all' }
  if (RESUME_ALL_RE.test(joined)) return { kind: 'resume-all' }
  if (STOP_ALL_RE.test(joined)) return { kind: 'stop-all' }
  const all = aliases(list)
  const w0 = toks[0].w
  const w1 = toks[1]?.w ?? ''
  const unknown = (i: number): BuddyCommand | null => {
    const name = namedBuddyWords(toks, i)
    return name ? { kind: 'unknown', name } : null
  }

  // stop / pause / turn off / turn on <name>
  const verb2 = `${w0} ${w1}`
  const control = (at: number, make: (id: string) => Built): BuddyCommand | null => {
    const hit = nameAt(toks, at, all)
    if (!hit) return unknown(at)
    return hit.whole && onlyFiller(toks, hit.next) ? pick(hit, make) : null
  }
  if (STOP.has(w0)) return control(1, (id) => ({ kind: 'stop', id }))
  if (OFF.has(w0)) return control(1, (id) => ({ kind: 'enable', id, on: false }))
  if (ON.has(w0)) return control(1, (id) => ({ kind: 'enable', id, on: true }))
  if (verb2 === 'turn off' || verb2 === 'switch off')
    return control(2, (id) => ({ kind: 'enable', id, on: false }))
  if (verb2 === 'turn on' || verb2 === 'switch on')
    return control(2, (id) => ({ kind: 'enable', id, on: true }))
  if (w0 === 'turn' || w0 === 'switch') {
    const hit = nameAt(toks, 1, all)
    if (hit?.whole) {
      const rest = toks.slice(hit.next).map((t) => t.w)
      if (rest[0] === 'off' && onlyFiller(toks, hit.next + 1))
        return pick(hit, (id) => ({ kind: 'enable', id, on: false }))
      const on = rest[0] === 'back' ? 1 : 0
      if (rest[on] === 'on' && onlyFiller(toks, hit.next + on + 1))
        return pick(hit, (id) => ({ kind: 'enable', id, on: true }))
    }
    return null
  }

  // what did <name> find / say / report …
  if (w0 === 'what' && (w1 === 'did' || w1 === 'has')) {
    const at = 2
    const hit = nameAt(toks, at, all)
    const v = hit ? toks[hit.next]?.w : undefined
    // The whole name: "what did the market do today" is a question, not Market Buddy's result.
    if (hit?.whole && v && (LAST_VERBS.has(v) || v === 'found' || v === 'said'))
      return pick(hit, (id) => ({ kind: 'last', id }))
    if (!hit && toks.slice(at).some((t) => LAST_VERBS.has(t.w))) return unknown(at)
    return null
  }

  // ask <name> to … / have <name> … / get <name> to … / run <name> now
  if (w0 === 'ask' || w0 === 'tell' || w0 === 'have' || w0 === 'get' || w0 === 'let') {
    const hit = nameAt(toks, 1, all)
    if (!hit) return unknown(1)
    let next = hit.next
    const to = toks[next]?.w === 'to'
    if (to) next++
    // A short name only in "ask / tell <name> to …".
    if (!hit.strong && !((w0 === 'ask' || w0 === 'tell') && to)) return null
    const utterance = restFrom(text, toks, next)
    if (!utterance && w0 !== 'ask') return null
    return pick(hit, (id) => ({ kind: 'call', id, utterance }))
  }
  if (w0 === 'run' || w0 === 'start') {
    const hit = nameAt(toks, 1, all)
    if (!hit) {
      const u = unknown(1)
      return u && onlyFiller(toks, toks.findIndex((t) => BUDDY_WORDS.has(t.w)) + 1) ? u : null
    }
    return hit.whole && onlyFiller(toks, hit.next)
      ? pick(hit, (id) => ({ kind: 'call', id, utterance: '' }))
      : null
  }

  // [hey] <name>, …
  const addressed = ADDRESS.has(w0) ? 1 : 0
  const hit = nameAt(toks, addressed, all)
  if (hit) {
    const sep = separated(text, toks, hit.next)
    if (!hit.strong && !sep && !HEY.has(w0)) return null
    return pick(hit, (id) => ({ kind: 'call', id, utterance: restFrom(text, toks, hit.next) }))
  }
  // "Foo Buddy, …" with no Foo Buddy (a lone "buddy" is just a way of talking).
  const name = namedBuddyWords(toks, addressed)
  if (name && name.split(' ').length >= 2) {
    const end = toks.findIndex((t, k) => k >= addressed && BUDDY_WORDS.has(t.w))
    if (separated(text, toks, end + 1)) return { kind: 'unknown', name }
  }
  return null
}

/** Words around the answer to "which buddy?" that say nothing ("the first one, please"). */
const WHICH_FILLER = new Set(['the', 'one', 'please', 'i', 'mean', 'that', 'oh', 'um', 'uh', 'yes'])

/**
 * Which of `ids` the whole reply names ("the price one", "Price Buddy", "the second"); null when
 * the reply is anything else ("open the first email" is a new request, not an answer).
 */
export function resolveWhich(text: string, refs: readonly BuddyRef[]): string | null {
  const toks = tokens(text).filter((t) => !WHICH_FILLER.has(t.w))
  if (!toks.length) return null
  const hit = nameAt(toks, 0, aliases(refs))
  if (hit && hit.ids.length === 1 && hit.next === toks.length) return hit.ids[0]
  if (toks.length !== 1) return null
  const ord = ['first', 'second', 'third', 'fourth'].indexOf(toks[0].w)
  return ord >= 0 && refs[ord] ? refs[ord].id : null
}

// ---- spoken lines ----

const firstSentence = (s: string, max = 200): string => {
  const one = (s.split(/(?<=[.!?])\s+/)[0] ?? '').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

/** "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function agoText(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "at 08:00", "tomorrow at 08:00", "on Friday at 08:00", "on 3/14 at 08:00" (local time). */
export function whenText(at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const dayStart = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((dayStart(d) - dayStart(today)) / 86_400_000)
  if (days <= 0) return `at ${hhmm(d)}`
  if (days === 1) return `tomorrow at ${hhmm(d)}`
  if (days < 7) return `on ${DAYS[d.getDay()]} at ${hhmm(d)}`
  return `on ${d.getMonth() + 1}/${d.getDate()} at ${hhmm(d)}`
}

/** One buddy's line for "what are my buddies doing". */
export function statusLine(s: BuddySummary, nextRunAt: number | undefined, now: number): string {
  if (s.running) return `${s.name} is working right now.`
  if (!s.enabled) return `${s.name} is turned off.`
  const last = s.lastRun
  const parts: string[] = []
  if (last) {
    const said = last.summary ? firstSentence(last.summary) : ''
    const at = last.endedAt ?? last.startedAt
    parts.push(
      `${s.name} last ran ${agoText(at, now)}${said ? `: ${said.replace(/[.!?]$/, '')}.` : '.'}`
    )
  } else parts.push(`${s.name} hasn’t run yet.`)
  if (nextRunAt !== undefined) parts.push(`Next run ${whenText(nextRunAt, now)}.`)
  return parts.join(' ')
}

const MAX_SPOKEN = 6

export function statusText(
  list: readonly BuddySummary[],
  nextRun: (s: BuddySummary) => number | undefined,
  pausedAll: boolean,
  now: number
): { text: string; spoken: string } {
  if (!list.length) {
    const t = 'You have no buddies yet. Say “make a buddy that …” to make one.'
    return { text: t, spoken: t }
  }
  const lines = list.map((s) => statusLine(s, pausedAll ? undefined : nextRun(s), now))
  const head = pausedAll
    ? 'All buddies are paused: scheduled runs wait until you say “resume buddies”.'
    : ''
  const text = [head, ...lines.map((l) => `- ${l}`)].filter(Boolean).join('\n')
  const more = list.length > MAX_SPOKEN ? ` And ${list.length - MAX_SPOKEN} more in Settings.` : ''
  const spoken = [head, ...lines.slice(0, MAX_SPOKEN)].filter(Boolean).join(' ') + more
  return { text, spoken }
}

/** "what did Inbox Buddy find". */
export function lastText(
  name: string,
  running: boolean,
  last: BuddyRunSummary | undefined,
  now: number
): string {
  if (!last) return running ? `${name} is on its first run now.` : `${name} hasn’t run yet.`
  const at = last.endedAt ?? last.startedAt
  if (!last.endedAt) return `${name} is still working on it.`
  const head = `${name}, ${agoText(at, now)}`
  if (last.phase === 'failed')
    return `${head}: it failed. ${firstSentence(last.summary ?? '')}`.trim()
  if (last.phase === 'cancelled') return `${head}: that run was stopped.`
  return last.summary
    ? `${head}: ${last.summary.trim()}`
    : `${head}: it finished without a summary.`
}

// ---- the turn ----

export interface BuddyVoiceDeps {
  list(): Buddy[]
  summaries(): BuddySummary[]
  /** Runs the buddy now (background, or on screen); the reply. */
  call(b: Buddy, utterance: string): Promise<ModelResponse>
  /** Cancels its running tasks; how many. */
  stop(id: string): number
  stopAll(): number
  setEnabled(id: string, on: boolean): boolean
  pausedAll(): boolean
  setPausedAll(paused: boolean): void
  nextRunAt(id: string): number | undefined
  lastRun(id: string): BuddyRunSummary | undefined
  now(): number
}

const WHICH_MS = 60_000

const answer = (text: string, spoken = text): ModelResponse => ({ mode: 'answer', text, spoken })

const orList = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`

export class BuddyVoice {
  private waiting: {
    command: Exclude<BuddyCommand, { kind: 'ambiguous' }>
    ids: string[]
    until: number
  } | null = null

  constructor(private readonly deps: BuddyVoiceDeps) {}

  /** The reply when the words are a buddy command; null when they are not. */
  async turn(text: string): Promise<ModelResponse | null> {
    const list = this.deps.list()
    const refs = list.map((b) => ({ id: b.id, name: b.name }))
    const w = this.waiting
    this.waiting = null
    if (w && this.deps.now() < w.until) {
      const id = resolveWhich(
        text,
        refs.filter((r) => w.ids.includes(r.id))
      )
      if (id) return this.run({ ...w.command, id } as BuddyCommand, list)
    }
    const cmd = parseBuddyCommand(text, refs)
    return cmd ? this.run(cmd, list) : null
  }

  private async run(cmd: BuddyCommand, list: Buddy[]): Promise<ModelResponse> {
    const d = this.deps
    const byId = (id: string): Buddy | undefined => list.find((b) => b.id === id)
    switch (cmd.kind) {
      case 'unknown':
        return answer(
          list.length
            ? `I don’t have a buddy called ${titleCase(cmd.name)}. Your buddies: ${orList(list.map((b) => b.name)).replace(/ or /, ' and ')}.`
            : `You have no buddies yet. Say “make a buddy that …” to make one.`
        )
      case 'ambiguous': {
        if ('id' in cmd.command)
          this.waiting = { command: cmd.command, ids: cmd.ids, until: d.now() + WHICH_MS }
        const names = cmd.ids.map((id) => byId(id)?.name ?? id)
        return answer(`Which buddy: ${orList(names)}?`)
      }
      case 'status': {
        const s = statusText(d.summaries(), (x) => d.nextRunAt(x.id), d.pausedAll(), d.now())
        return answer(s.text, s.spoken)
      }
      case 'pause-all':
        d.setPausedAll(true)
        return answer(
          'Paused all buddies: their scheduled runs wait until you say “resume buddies”. You can still call one by name.'
        )
      case 'resume-all':
        d.setPausedAll(false)
        return answer('Buddies are back on schedule.')
      case 'stop-all': {
        const n = d.stopAll()
        return answer(
          n
            ? `Stopped ${n === 1 ? 'one buddy task' : `${n} buddy tasks`}.`
            : 'No buddy is working right now.'
        )
      }
    }
    const b = byId(cmd.id)
    if (!b) return answer('That buddy is gone.')
    switch (cmd.kind) {
      case 'stop': {
        const n = d.stop(b.id)
        return answer(n ? `Stopped ${b.name}.` : `${b.name} isn’t working right now.`)
      }
      case 'enable':
        if (!d.setEnabled(b.id, cmd.on)) return answer('That buddy is gone.')
        return answer(
          cmd.on
            ? `${b.name} is on again.`
            : `${b.name} is off: it won’t run until you say “turn on ${b.name}”.`
        )
      case 'last': {
        const running = d.summaries().find((s) => s.id === b.id)?.running ?? false
        return answer(lastText(b.name, running, d.lastRun(b.id), d.now()))
      }
      case 'call':
        return d.call(b, cmd.utterance)
    }
  }
}

const titleCase = (s: string): string => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
