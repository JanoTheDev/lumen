// Local grammar for files: "make a Word doc of …", "convert this csv to Excel", "turn this into
// a table", "save it on my desktop", and "open it" / "show it in Explorer" afterwards. Pure.
import type { DocFormat, Place } from './schema'

export interface MakeIntent {
  /** The format asked for, null when the user did not say (picked from the source). */
  format: DocFormat | null
  place: Place | null
  /** "replace the original": write over it (asks first). */
  replace: boolean
  /** A plain format change (CSV ↔ Excel) that needs no model. */
  convertOnly: boolean
  /** About an existing file ("turn this into a table", "clean up this document"). */
  reformat: boolean
}

const FORMATS: [RegExp, DocFormat][] = [
  [
    /\b(?:word\s+(?:docs?|documents?|files?|version|format)|docx|(?:ms|microsoft)\s+word|(?:in|into|to|as)\s+word)\b/gi,
    'docx'
  ],
  [/\b(?:excel|xlsx|spreadsheets?|workbooks?)\b/gi, 'xlsx'],
  [/\bcsv\b/gi, 'csv'],
  [/\bpdfs?\b/gi, 'pdf'],
  [/\b(?:markdown|md\s+file)\b/gi, 'md'],
  [/\b(?:text\s+file|txt|plain\s+text|notepad\s+file)\b/gi, 'txt'],
  [/\b(?:html|web\s*page\s+file)\b/gi, 'html']
]

/** Words after a format that make it a topic, not a file ("a csv parser"). */
const NOT_A_FILE =
  /^\s*(?:parser|reader|library|libraries|formula|formulas|function|functions|macro|macros|tutorial|course|plugin|add-?in|export(?:er)?|viewer|editor)\b/i

const VERB =
  /\b(?:make|create|write|save|generate|draft|produce|build|export|put|turn|convert|change|reformat|clean(?:\s+(?:it|this|that))?\s+up|tidy(?:\s+(?:it|this|that))?\s+up|summari[sz]e|rewrite|compile|prepare|give me|i need|can i (?:get|have))\b/i

/** The format the request asks for: the last one not named as the source ("this csv"). */
export function targetFormat(prompt: string): DocFormat | null {
  let best: { at: number; f: DocFormat } | null = null
  for (const [re, f] of FORMATS) {
    re.lastIndex = 0
    for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
      const before = prompt.slice(0, m.index)
      if (
        /\b(?:this|that|these|those|the|my|your|its)\s+(?:\w+\s+)?$/i.test(before) &&
        !/\b(?:into|to|as)\s+(?:a\s+|an\s+)?(?:the\s+)?$/i.test(before)
      )
        continue
      if (NOT_A_FILE.test(prompt.slice(m.index + m[0].length))) continue
      if (!best || m.index > best.at) best = { at: m.index, f }
    }
  }
  return best?.f ?? null
}

const REFORMAT =
  /\b(?:turn|make|put|convert|change|format)\b.{0,40}\b(?:into|as|in(?:to)?)\s+(?:a\s+|an\s+)?(?:nice\s+|neat\s+|proper\s+)?(?:table|bullet(?:ed)?\s+list|numbered\s+list|list|one[- ]pager|one[- ]page\s+(?:doc|document|summary))\b|\b(?:clean(?:\s+(?:it|this|that))?\s+up|tidy(?:\s+(?:it|this|that))?\s+up|reformat|fix\s+the\s+formatting\s+of)\b/i

const FILE_REF =
  /\b(?:this|that|the|my)\s+(?:file|document|doc|pdf|spreadsheet|sheet|workbook|csv|presentation|deck|report|notes|table)\b/i

export function placeOf(prompt: string): Place | null {
  if (/\b(?:on|to|onto)\s+(?:my\s+|the\s+)?desktop\b/i.test(prompt)) return 'desktop'
  if (
    /\bnext\s+to\s+(?:it|this|that|the\s+(?:original|source|old\s+one|file|other\s+one))\b|\b(?:same|that)\s+folder\b|\bwhere\s+(?:it|the\s+original)\s+is\b/i.test(
      prompt
    )
  )
    return 'next_to_source'
  if (/\b(?:in|to|into)\s+(?:my\s+|the\s+)?downloads\b/i.test(prompt)) return 'downloads'
  if (/\b(?:in|to|into)\s+(?:my\s+|the\s+)?documents(?:\s+folder)?\b/i.test(prompt))
    return 'documents'
  return null
}

const REPLACE =
  /\b(?:replace|overwrite)\s+(?:the\s+original|it|the\s+(?:old\s+)?file|the\s+old\s+one|that\s+file)\b|\bin\s+place\b|\bsave\s+over\b/i

/** How-to and other questions ("how do I make a pivot table in Excel?") are answers. */
const QUESTION =
  /^(?:how|what|why|when|where|which|who|is|are|does|do|did|should|explain|tell me)\b/i

const CHANGES =
  /\b(?:clean|summar|translat|sort|filter|only|remove|delete|add|fix|rewrite|shorten|chart|group|total|tidy|merge|split|rename)/i

/**
 * A request to make a file, or null. `hasFiles`: files are shared (a format-less "turn this
 * into a table" is about them; without files it is about the screen and not ours).
 */
export function makeIntent(prompt: string, hasFiles: boolean): MakeIntent | null {
  const p = prompt.trim()
  if (p.length > 600 || QUESTION.test(p) || (/\?\s*$/.test(p) && !VERB.test(p))) return null
  const format = targetFormat(p)
  const reformat = REFORMAT.test(p)
  const verb = VERB.test(p)
  if (!(verb && format) && !(reformat && (hasFiles || FILE_REF.test(p)))) return null
  const fromTable = /\b(?:csv|tsv|excel|xlsx|spreadsheet|sheet|workbook)\b/i.test(p) || hasFiles
  return {
    format,
    place: placeOf(p),
    replace: REPLACE.test(p),
    convertOnly:
      !!format &&
      (format === 'xlsx' || format === 'csv') &&
      fromTable &&
      /\b(?:convert|turn|export|save|change|make)\b/i.test(p) &&
      !CHANGES.test(p),
    reformat: reformat || /\b(?:this|that|it)\b/i.test(p)
  }
}

export type OpenIntent = 'open' | 'reveal'

const OPEN =
  /^(?:ok(?:ay)?,?\s+)?(?:please\s+)?(?:open|show\s+me|launch)\s+(?:it|the\s+(?:new\s+)?(?:file|document|doc|spreadsheet|sheet|pdf|csv|workbook))(?:\s+(?:up|please|now))*[.!]?$/i
const REVEAL =
  /\b(?:show|open|find)\s+(?:it|that|me|the\s+(?:file|document|folder))?\s*(?:in|with)\s+(?:file\s+)?explorer\b|^(?:please\s+)?open\s+the\s+folder\b|^where\s+did\s+you\s+(?:save|put)\s+it\b/i

export function openIntent(prompt: string): OpenIntent | null {
  const p = prompt.trim()
  if (REVEAL.test(p)) return 'reveal'
  if (OPEN.test(p)) return 'open'
  return null
}
