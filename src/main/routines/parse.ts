// Spoken / typed automations: "every weekday at 9 summarize my inbox", "every hour between 9
// and 5 check the build", "every month on the 1st …", "tomorrow at 8 …", "in 20 minutes remind
// me to stretch", "when I open Excel, remind me to save a copy", "when a PDF lands in
// Downloads, rename it by its title", "when I'm back, …", "when the internet comes back, …",
// "when I log in, …". Local and deterministic; null = not an automation request.
import type { AutomationAction, AutomationTrigger } from '@shared/automations'
import { reminderLine } from './proactive'
import {
  cleanPrompt,
  DAY_WORDS,
  leading,
  MIN_EVERY_MINUTES,
  NOT_A_TASK_RE,
  num,
  NUM,
  parseTime,
  TIME
} from './schedule'
import { validTrigger } from './triggers'

export interface ParseOpts {
  now: number
  /** "downloads" / "my documents" / an absolute path → the folder, or null when unknown. */
  resolveFolder?: (name: string) => string | null
}

export type ParsedAutomation =
  | { ok: true; trigger: AutomationTrigger; action: AutomationAction; usedDefaultTime: boolean }
  | { ok: false; reason: string }

interface Lead {
  trigger: AutomationTrigger
  rest: string
  /** No time was said; a default was used. */
  def: boolean
  /** A folder name nobody could resolve. */
  unknownFolder?: string
}

const DELIM = String.raw`(?:,\s*|\s+then\s+|\s+(?=(?:remind|tell) me\b|say\b)|$)`
/** NUM without its own capture group. */
const NUM_X = NUM.replace(/^\(/, '(?:')
const DUR = String.raw`(${NUM_X}|an?|half an?) (minutes?|mins?|hours?)`
const BARE_TIME = String.raw`(noon|midnight|\d{1,2}(?:[:.]\d{2})?(?: ?[ap]\.?m\.?)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`
const WEEKDAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)'

const PREFIX_RE =
  /^(?:please )?(?:create|add|make|set up|setup|start|new) (?:an? |me an? )?(?:new )?(?:automation|routine)(?: that| which| to| for)?[:,]? */

const STARTUP_RE =
  /^(?:when(?:ever)? (?:lumen (?:starts|opens|launches)|i (?:log ?in|log on|sign in|start (?:up )?(?:my )?(?:pc|computer|laptop|lumen)|turn on (?:my )?(?:pc|computer|laptop))|(?:my |the )?(?:pc|computer|laptop) (?:starts|boots|turns on))|(?:at|on|after) (?:login|log ?in|logon|sign[- ]?in|startup|start ?up|boot))\b/
const ONLINE_RE =
  /^when(?:ever)? (?:(?:i'?m|i am|we'?re|we are|i get|(?:the|my) (?:pc|computer|laptop) (?:is|gets)) (?:back )?(?:online|connected)(?: again)?|(?:the |my )?(?:internet|network|wifi|wi-fi|connection) (?:comes back|is back|returns|reconnects|is (?:back )?(?:on|up)(?: again)?))\b/
const IDLE_RE = new RegExp(
  String.raw`^when(?:ever)? (?:i'?m|i am|i'?ve been|i have been|i go|i get|(?:the|my) (?:pc|computer|laptop) (?:is|has been|goes)) (?:idle|away|afk|inactive)(?: from (?:the |my )?(?:pc|computer|desk|keyboard))?(?: for ${DUR})?\b`
)
const IDLE_AFTER_RE = new RegExp(
  String.raw`^after ${DUR} (?:of (?:inactivity|idling|being idle|being away|no input)|without (?:any )?input|idle|away)\b`
)
const BACK_RE = new RegExp(
  String.raw`^when(?:ever)? (?:i (?:come|get) back|i return|i'?m back|i am back)(?: (?:to (?:my |the )?(?:pc|computer|desk|laptop)|from (?:being )?(?:idle|away|a break|lunch|my break)))?(?: after ${DUR})?\b`
)
const APP_RE = new RegExp(
  String.raw`^(?:when(?:ever)?|each time|every time|if|after|once) i (open|start|launch|switch to|go to|use|close|quit|exit|shut down|shut) (?:the |my )?(.+?)(?: (?:app|application|program))?${DELIM}`
)
const APP_SUBJECT_RE = new RegExp(
  String.raw`^when(?:ever)? (?:the |my )?([\p{L}\p{N} .+&-]{2,40}?) (opens|starts|launches|is opened|is started|closes|quits|exits|is closed)${DELIM}`,
  'u'
)
const FILE_ADDED_RE = new RegExp(
  String.raw`^when(?:ever)? (?:an? |any |new |the )*(?:([a-z0-9]+) )?(?:files? |documents? |downloads? )?(?:lands?|appears?|arrives?|shows? up|comes? in|(?:is|are|gets?) (?:added|saved|downloaded|created|dropped|put|moved)) (?:in|into|to|on) (?:my |the )?(.+?)(?: folder)?${DELIM}`
)
const FILE_CHANGED_IN_RE = new RegExp(
  String.raw`^when(?:ever)? (?:an? |any )?(?:([a-z0-9]+) )?(?:files?|something|anything|documents?) (?:in|inside) (?:my |the )?(.+?)(?: folder)? (?:changes|is changed|is modified|is updated|is edited|gets (?:changed|modified|updated|edited))${DELIM}`
)
const FILE_CHANGES_RE = new RegExp(
  String.raw`^when(?:ever)? (?:an? |any )?(?:([a-z0-9]+) )?(?:files?|something|anything|documents?) (?:changes|is changed|is modified|is updated|gets (?:changed|modified|updated)) in (?:my |the )?(.+?)(?: folder)?${DELIM}`
)
const MONTHLY_RE = new RegExp(
  String.raw`^(?:(?:every|each) month|monthly)(?: on the (\d{1,2})(?:st|nd|rd|th)?)?(?: ${TIME})?\b`
)
const MONTHLY_ON_RE = new RegExp(
  String.raw`^on the (\d{1,2})(?:st|nd|rd|th)? of (?:every|each|the) month(?: ${TIME})?\b`
)
const BETWEEN_RE = new RegExp(
  String.raw`^ ?(?:between|from) ${BARE_TIME} (?:and|to|until|till) ${BARE_TIME}(?: (?:on|every) (weekdays?|week ?days?|weekends?))?\b`
)
const DAY_RE = new RegExp(
  String.raw`^(today|tomorrow|tonight)(?: (morning|afternoon|evening|night))?(?: ${TIME})?\b`
)
const IN_RE = new RegExp(String.raw`^in ${DUR}( and a half)?\b`)
const AT_RE = new RegExp(
  String.raw`^(?:at|@) ?${BARE_TIME}(?: ?(am|pm))?(?: (today|tomorrow|tonight))?\b`
)
const ON_DAY_RE = new RegExp(String.raw`^(?:on |this |next )${WEEKDAY}(?!s)(?: ${TIME})?\b`)

const FILE_KINDS: Record<string, string> = {
  pdf: '*.pdf',
  csv: '*.csv',
  zip: '*.zip',
  word: '*.docx',
  docx: '*.docx',
  excel: '*.xlsx',
  xlsx: '*.xlsx',
  spreadsheet: '*.xlsx',
  png: '*.png',
  screenshot: '*.png',
  jpg: '*.jpg',
  jpeg: '*.jpg',
  photo: '*.jpg',
  txt: '*.txt',
  text: '*.txt',
  mp3: '*.mp3',
  mp4: '*.mp4',
  video: '*.mp4',
  invoice: '*.pdf'
}
const GENERIC_KINDS = new Set(['file', 'new', 'document', 'download', 'something', 'anything'])

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function minutesOf(n: string, unit: string, half = false): number | null {
  const base = /^half/.test(n) ? 0.5 : /^an?$/.test(n) ? 1 : num(n.replace('-', ' '))
  if (base === null) return null
  const m = /^h/.test(unit) ? base * 60 : base
  return Math.round(half ? m + (/^h/.test(unit) ? 30 : 0.5) : m)
}

function patternFor(kind?: string): string | undefined | null {
  if (!kind || GENERIC_KINDS.has(kind)) return undefined
  const k = kind.replace(/s$/, '')
  return FILE_KINDS[k] ?? FILE_KINDS[kind] ?? null
}

function fileLead(
  folderWord: string,
  kind: string | undefined,
  on: 'added' | 'changed',
  rest: string,
  opts: ParseOpts
): Lead | null {
  const pattern = patternFor(kind)
  if (pattern === null) return null
  const word = folderWord.trim()
  const folder = opts.resolveFolder?.(word) ?? null
  return {
    trigger: { kind: 'file', folder: folder ?? '', on, ...(pattern ? { pattern } : {}) },
    rest,
    def: false,
    ...(folder ? {} : { unknownFolder: word })
  }
}

/** A day offset + "HH:MM" → ms epoch (local wall clock). */
function onDay(now: number, offset: number, at: string): number {
  const d = new Date(now)
  const [h, m] = at.split(':').map(Number)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, h, m).getTime()
}

function onceLead(t: string, opts: ParseOpts): Lead | null {
  const now = opts.now
  const d = DAY_RE.exec(t)
  if (d) {
    const [, which, part, time, partAfter] = d
    const p = partAfter ?? part ?? (which === 'tonight' ? 'evening' : undefined)
    const defaults: Record<string, string> = {
      morning: '09:00',
      afternoon: '15:00',
      evening: '19:00',
      night: '21:00'
    }
    const at = time ? parseTime(time, p) : p ? defaults[p] : which === 'tomorrow' ? '09:00' : null
    if (!at) return null
    return {
      trigger: { kind: 'once', at: onDay(now, which === 'tomorrow' ? 1 : 0, at) },
      rest: t.slice(d[0].length),
      def: !time
    }
  }
  const i = IN_RE.exec(t)
  if (i) {
    const m = minutesOf(i[1], i[2], !!i[3])
    if (!m) return null
    return {
      trigger: { kind: 'once', at: now + m * 60_000 },
      rest: t.slice(i[0].length),
      def: false
    }
  }
  const a = AT_RE.exec(t)
  if (a) {
    const at = parseTime(
      `${a[1]}${a[2] ? ` ${a[2]}` : ''}`,
      a[3] === 'tonight' ? 'evening' : undefined
    )
    if (!at) return null
    let when = onDay(now, a[3] === 'tomorrow' ? 1 : 0, at)
    if (!a[3] && when <= now) when = onDay(now, 1, at)
    return { trigger: { kind: 'once', at: when }, rest: t.slice(a[0].length), def: false }
  }
  const o = ON_DAY_RE.exec(t)
  if (o) {
    const want = DAY_WORDS[o[1]]
    const at = o[2] ? parseTime(o[2], o[3]) : '09:00'
    if (!at) return null
    const today = new Date(now).getDay()
    let offset = (want - today + 7) % 7
    if (offset === 0 && onDay(now, 0, at) <= now) offset = 7
    if (t.startsWith('next ') && offset === 0) offset = 7
    return {
      trigger: { kind: 'once', at: onDay(now, offset, at) },
      rest: t.slice(o[0].length),
      def: !o[2]
    }
  }
  return null
}

/** The trigger at the start of `t` (normalized), and what follows it. */
export function leadingTrigger(t: string, opts: ParseOpts): Lead | null {
  let m = STARTUP_RE.exec(t)
  if (m) return { trigger: { kind: 'startup' }, rest: t.slice(m[0].length), def: false }
  m = ONLINE_RE.exec(t)
  if (m) return { trigger: { kind: 'online' }, rest: t.slice(m[0].length), def: false }
  m = IDLE_RE.exec(t) ?? IDLE_AFTER_RE.exec(t)
  if (m) {
    const minutes = m[1] ? minutesOf(m[1], m[2]) : 10
    if (!minutes) return null
    return {
      trigger: { kind: 'idle', minutes, on: 'idle' },
      rest: t.slice(m[0].length),
      def: false
    }
  }
  m = BACK_RE.exec(t)
  if (m) {
    const minutes = m[1] ? minutesOf(m[1], m[2]) : 10
    if (!minutes) return null
    return {
      trigger: { kind: 'idle', minutes, on: 'back' },
      rest: t.slice(m[0].length),
      def: false
    }
  }
  m = FILE_ADDED_RE.exec(t)
  if (m) return fileLead(m[2], m[1], 'added', t.slice(m[0].length), opts)
  m = FILE_CHANGED_IN_RE.exec(t) ?? FILE_CHANGES_RE.exec(t)
  if (m) return fileLead(m[2], m[1], 'changed', t.slice(m[0].length), opts)
  m = APP_RE.exec(t)
  if (m) {
    const app = m[2].trim()
    if (!app || app.split(' ').length > 4) return null
    const on = /^(?:close|quit|exit|shut)/.test(m[1]) ? 'close' : 'open'
    return { trigger: { kind: 'app', app, on }, rest: t.slice(m[0].length), def: false }
  }
  m = APP_SUBJECT_RE.exec(t)
  if (m && !/^(?:it|this|that|something|anything|a |an |i )/.test(m[1])) {
    const on = /close|quit|exit/.test(m[2]) ? 'close' : 'open'
    return {
      trigger: { kind: 'app', app: m[1].trim(), on },
      rest: t.slice(m[0].length),
      def: false
    }
  }
  m = MONTHLY_RE.exec(t) ?? MONTHLY_ON_RE.exec(t)
  if (m) {
    const at = m[2] ? parseTime(m[2], m[3]) : '09:00'
    if (!at) return null
    return {
      trigger: { kind: 'monthly', day: m[1] ? Number(m[1]) : 1, at },
      rest: t.slice(m[0].length),
      def: !m[2]
    }
  }
  const once = onceLead(t, opts)
  if (once) return once
  const s = leading(t)
  if (!s) return null
  if (s.schedule.kind === 'every') {
    const w = BETWEEN_RE.exec(s.rest)
    if (w) {
      const from = parseTime(w[1])
      let to = parseTime(w[2])
      if (!from || !to) return null
      // "between 9 and 5": the end is in the afternoon.
      if (to <= from && Number(to.slice(0, 2)) < 12)
        to = `${String(Number(to.slice(0, 2)) + 12).padStart(2, '0')}${to.slice(2)}`
      const days = !w[3] ? undefined : /^week ?days?$/.test(w[3]) ? [1, 2, 3, 4, 5] : [0, 6]
      return {
        trigger: {
          kind: 'every',
          minutes: s.schedule.minutes,
          from,
          to,
          ...(days ? { days } : {})
        },
        rest: s.rest.slice(w[0].length),
        def: false
      }
    }
  }
  return { trigger: s.schedule, rest: s.rest, def: s.def }
}

/** Where a trigger may start inside a sentence ("… every day at 6", "… when I log in"). */
const TAIL_RE =
  /(?:^| )(?=every |each |daily|monthly|on the \d|on (?:sun|mon|tue|wed|thu|fri|sat|week)|this (?:sun|mon|tue|wed|thu|fri|sat)|next (?:sun|mon|tue|wed|thu|fri|sat)|tomorrow|today|tonight|in (?:\d|an? |half|one|two|three|four|five|ten|fifteen|twenty|thirty)|at (?:\d|noon|midnight)|when(?:ever)? |after (?:\d|an? |half|login|log ?in|startup))/g

function tailTrigger(t: string, opts: ParseOpts): { lead: Lead; head: string } | null {
  for (const m of t.matchAll(TAIL_RE)) {
    const at = (m.index ?? 0) + (m[0].startsWith(' ') ? 1 : 0)
    if (at === 0) continue
    const lead = leadingTrigger(t.slice(at), opts)
    if (lead && !cleanPrompt(lead.rest)) return { lead, head: t.slice(0, at) }
  }
  return null
}

/** The user's own casing for a piece of the normalized text. */
function original(utterance: string, piece: string): string {
  const flat = utterance.replace(/[“”"]/g, '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
  const i = flat.toLowerCase().indexOf(piece)
  return i >= 0 ? flat.slice(i, i + piece.length) : piece
}

/** The app name as the user wrote it ("Excel", not "excel"). */
function withAppCase(t: AutomationTrigger, utterance: string): AutomationTrigger {
  return t.kind === 'app' ? { ...t, app: original(utterance, t.app) } : t
}

const REMIND_RE = /^(?:then )?(remind me(?: to| that| about)?|tell me(?: to| that)?|say) (.+)$/
const SKILL_RE =
  /^(?:run|use|start) (?:the |my )?skill (.+)$|^(?:run|use|start) (?:the |my )?(.+?) skill$/

function actionFrom(rest: string, utterance: string): AutomationAction | null {
  const r = cleanPrompt(rest)
  if (!r) return null
  const remind = REMIND_RE.exec(r)
  if (remind) {
    const what = original(utterance, remind[2]).trim()
    if (!what || what.length > 200) return null
    return { kind: 'remind', say: reminderLine(remind[1], what) }
  }
  const skill = SKILL_RE.exec(r)
  if (skill) return { kind: 'skill', skill: original(utterance, (skill[1] ?? skill[2]).trim()) }
  return { kind: 'task', prompt: original(utterance, r) }
}

const REMIND_LEAD_RE = /^remind me (.+?) (to|that|about) (.+)$/

/**
 * A spoken or typed automation. null = not one (an ordinary question or command);
 * `{ok: false}` = clearly meant as one but something is missing or wrong (the reason is said).
 */
export function parseAutomationUtterance(
  utterance: string,
  opts: ParseOpts
): ParsedAutomation | null {
  let t = normalize(utterance)
  const prefixed = PREFIX_RE.exec(t)
  if (prefixed) t = t.slice(prefixed[0].length)
  let lead: Lead | null = null
  let rest = ''
  const r = REMIND_LEAD_RE.exec(t)
  if (r) {
    const l = leadingTrigger(r[1], opts)
    if (l && !cleanPrompt(l.rest)) {
      lead = l
      rest = `remind me ${r[2]} ${r[3]}`
    }
  }
  if (!lead) {
    lead = leadingTrigger(t, opts)
    if (lead) rest = lead.rest
  }
  const remindFirst = /^remind me /.test(t)
  if (!lead && (prefixed || remindFirst)) {
    const tail = tailTrigger(t, opts)
    if (tail) {
      lead = tail.lead
      rest = tail.head
    }
  }
  if (!lead)
    return prefixed
      ? {
          ok: false,
          reason: 'When should it run? For example “every weekday at 9” or “when I open Excel”.'
        }
      : null
  const action = actionFrom(rest, utterance)
  if (!action)
    return prefixed || remindFirst
      ? {
          ok: false,
          reason:
            'What should it do? Say when, then what, for example “every weekday at 9 summarize my inbox”.'
        }
      : null
  if (action.kind === 'task' && !prefixed) {
    // Without "create an automation", only an imperative after an explicit trigger counts:
    // "every day is a gift" or "when I open Excel, how do I …" stay ordinary questions.
    const vague = lead.def && /^(?:(?:every|each|on) days?|daily)\b/.test(t)
    if (vague || NOT_A_TASK_RE.test(action.prompt.toLowerCase())) return null
    if (action.prompt.split(' ').length < 2) return null
  }
  const trig = withAppCase(lead.trigger, utterance)
  if (lead.unknownFolder !== undefined)
    return {
      ok: false,
      reason: `I don’t know the folder “${lead.unknownFolder}”. Say Downloads, Documents, Desktop, Pictures, or a full path.`
    }
  if (trig.kind === 'every' && trig.minutes < MIN_EVERY_MINUTES)
    return { ok: false, reason: `Automations run at most every ${MIN_EVERY_MINUTES} minutes.` }
  if (trig.kind === 'once' && trig.at <= opts.now)
    return { ok: false, reason: 'That time has already passed.' }
  if (!validTrigger(trig))
    return { ok: false, reason: 'I could not understand when it should run.' }
  return { ok: true, trigger: trig, action, usedDefaultTime: lead.def }
}

/** Settings' "When" field: the whole text must be one trigger. */
export function parseTriggerText(
  text: string,
  opts: ParseOpts
): { ok: true; trigger: AutomationTrigger } | { ok: false; reason: string } {
  const t = normalize(text).replace(/^(?:run |do it |remind me )/, '')
  const lead = leadingTrigger(t, opts)
  if (!lead || cleanPrompt(lead.rest))
    return {
      ok: false,
      reason: 'Try “every weekday at 9”, “tomorrow at 8” or “when I open Excel”.'
    }
  if (lead.unknownFolder !== undefined)
    return { ok: false, reason: `I don’t know the folder “${lead.unknownFolder}”.` }
  const trig = withAppCase(lead.trigger, text)
  if (trig.kind === 'every' && trig.minutes < MIN_EVERY_MINUTES)
    return { ok: false, reason: `At most every ${MIN_EVERY_MINUTES} minutes.` }
  if (trig.kind === 'once' && trig.at <= opts.now)
    return { ok: false, reason: 'That time has already passed.' }
  return validTrigger(trig)
    ? { ok: true, trigger: trig }
    : { ok: false, reason: 'That is not a valid time.' }
}
