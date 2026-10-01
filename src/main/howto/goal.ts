// How-to goals carry the user's words (05 T36). Two cleaned forms, no Electron:
// - outboundGoal: what may leave the machine (Microsoft Learn query, paid web search). Secrets,
//   addresses and quoted text are cut out.
// - noteGoal: what an app note may keep on disk: the task, not its content. Everything after
//   "that" / "saying" / ":" (what to write), quoted text, addresses, file names and long numbers
//   are dropped; null when nothing safe is left.
import { isSensitive, redact } from '../ai/memory/sensitive'
import { redactForModel } from '../actions/redact'

const QUOTED_RE = /["“”„«»][^"“”„«»]*["“”„«»]|(^|\s)['‘][^'‘’]*['’](?=$|[\s.,;:!?])/g
const REDACTED_RE = /\[redacted:[a-z-]+\]/g
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi

const squash = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()

/** The goal as sent to a web search: no secrets, addresses or quoted text. */
export function outboundGoal(goal: string): string {
  const cut = redact(redactForModel(goal), { emails: true })
    .replace(QUOTED_RE, '$1')
    .replace(REDACTED_RE, ' ')
    .replace(EMAIL_RE, ' ')
  return squash(cut).slice(0, 200)
}

/** What the user asked to write or say starts here ("reply to Sam that …", "saying …"). */
const CONTENT_START_RE =
  /\s(?:that|saying|says|telling|to say|with the (?:text|message|words|subject))\s.*$|:.*$/i
/** A word that is content rather than UI: an address, a file name, a link, a long number. */
const CONTENT_WORD_RE = /@|^\S+\.[a-z0-9]{2,5}$|^\d{4,}|^(?:https?:|www\.)/i

/** The goal as kept in an app note, or null when nothing but content would be left. */
export function noteGoal(goal: string): string | null {
  if (isSensitive(goal)) return null
  const head = goal
    .replace(/\s+/g, ' ')
    .replace(QUOTED_RE, '$1')
    .replace(URL_RE, ' ')
    .replace(CONTENT_START_RE, '')
  const words = head.split(' ').filter((w) => w && !CONTENT_WORD_RE.test(w))
  const g = squash(words.join(' ')).replace(/[\s,;:.!?-]+$/, '')
  if (!g || isSensitive(g, { emails: true })) return null
  return g.slice(0, 120)
}

/** A UI name an app note may keep: no address, file name, link or long number. */
export function isContentName(name: string): boolean {
  return (
    isSensitive(name, { emails: true }) ||
    /@/.test(name) ||
    /(?:^|\s)\S+\.[a-z0-9]{2,5}$/i.test(name.trim()) ||
    /(?:https?:\/\/|www\.)/i.test(name) ||
    /\d{4,}/.test(name)
  )
}
