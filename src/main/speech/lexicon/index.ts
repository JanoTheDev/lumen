// Short spoken answers per language: yes / no / always (confirms), stop (voice cancel) and the
// lesson words next / back / repeat. Whole utterances only: "no" answers a confirm, "no, I said
// …" does not. Pure; the tables are the JSON files next to this one.
import type { VoiceLanguage } from '@shared/config'
import de from './de.json'
import en from './en.json'
import es from './es.json'
import fr from './fr.json'
import it from './it.json'
import nl from './nl.json'
import pt from './pt.json'

export type LexiconWord = 'yes' | 'no' | 'always' | 'stop' | 'next' | 'back' | 'repeat'
export type Lang = Exclude<VoiceLanguage, 'auto'>

type Table = Record<LexiconWord, string[]>

const TABLES: Record<Lang, Table> = { en, es, de, fr, it, pt, nl }
export const LEXICON_LANGS = Object.keys(TABLES) as Lang[]

// Checked in this order: "si siempre" is always, not yes; "continue" is yes before next.
const ORDER: LexiconWord[] = ['always', 'yes', 'no', 'stop', 'next', 'back', 'repeat']

// Leading/trailing politeness that never changes the answer.
const EDGE_FILLERS = new Set([
  'please',
  'thanks',
  'thank you',
  'por favor',
  'gracias',
  'bitte',
  'danke',
  's il vous plait',
  's il te plait',
  'merci',
  'per favore',
  'grazie',
  'obrigado',
  'obrigada',
  'alsjeblieft',
  'graag',
  'dank je',
  'hey lumen',
  'lumen',
  'um',
  'uh',
  'eh',
  'oh'
])

/** Lowercase, accents and punctuation dropped, spaces collapsed ("¡Sí!" → "si"). */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripEdges(folded: string): string {
  let t = folded
  for (let i = 0; i < 4; i++) {
    let changed = false
    for (const f of EDGE_FILLERS) {
      if (t === f) continue
      if (t.startsWith(`${f} `)) {
        t = t.slice(f.length + 1)
        changed = true
      }
      if (t.endsWith(` ${f}`)) {
        t = t.slice(0, -f.length - 1)
        changed = true
      }
    }
    if (!changed) break
  }
  return t
}

/** The phrases of one word in one language, as written in the table. */
export function phrases(lang: Lang, word: LexiconWord): readonly string[] {
  return TABLES[lang][word]
}

const INDEX = new Map<Lang, Map<string, LexiconWord>>()
for (const lang of LEXICON_LANGS) {
  const map = new Map<string, LexiconWord>()
  for (const word of ORDER) {
    for (const phrase of TABLES[lang][word]) {
      const key = foldText(phrase)
      if (key && !map.has(key)) map.set(key, word)
    }
  }
  INDEX.set(lang, map)
}

/** Languages whose words count: the chosen one plus English; every table for auto. */
export function lexiconLangs(lang: VoiceLanguage | string | undefined): Lang[] {
  if (!lang || lang === 'auto') return LEXICON_LANGS
  const base = lang.toLowerCase().split('-')[0] as Lang
  if (!INDEX.has(base) || base === 'en') return ['en']
  return [base, 'en']
}

/** The word a whole utterance is in `lang`, or null. */
export function matchWord(text: string, lang?: VoiceLanguage | string): LexiconWord | null {
  if (!text || text.length > 60) return null
  const folded = stripEdges(foldText(text))
  if (!folded) return null
  for (const l of lexiconLangs(lang)) {
    const hit = INDEX.get(l)!.get(folded)
    if (hit) return hit
  }
  return null
}

export type ConfirmWord = 'yes' | 'no' | 'always'

/**
 * The answer to a waiting confirm: yes, no (stop and cancel count as no) or always; null when
 * the utterance is something else (a new request).
 */
export function matchConfirm(text: string, lang?: VoiceLanguage | string): ConfirmWord | null {
  const w = matchWord(text, lang)
  if (w === 'yes' || w === 'no' || w === 'always') return w
  return w === 'stop' ? 'no' : null
}

/** The English word the existing English-only matchers understand. */
const CANONICAL: Record<LexiconWord, string> = {
  yes: 'yes',
  no: 'no',
  always: 'always',
  stop: 'stop',
  next: 'next',
  back: 'back',
  repeat: 'repeat'
}

/**
 * A short answer in another language rewritten as its English word ("sí" → "yes",
 * "abbrechen" → "stop"), so confirm, lesson and cancel handling work unchanged. Anything else,
 * and every English utterance, is returned as is.
 */
export function canonicalUtterance(text: string, lang?: VoiceLanguage | string): string {
  const langs = lexiconLangs(lang).filter((l) => l !== 'en')
  if (!langs.length) return text
  const w = matchWord(text, lang)
  if (!w) return text
  // Words that are also English ("no", "ok", "stop") stay as they were.
  if (matchWord(text, 'en') === w) return text
  return CANONICAL[w]
}
