// Ordinal helpers shared by the target resolver (text + nth) and set-of-marks numbering.
import type { Rect } from '@shared/types'
import type { ClaudeResponse } from '../ai'

/** Normalize OCR-confusable characters (mirrors Python _ocr_norm). */
export function ocrNorm(s: string): string {
  return s.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/i/g, 'l')
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  last: -1
}

/** "third" → 3, "2nd" → 2, "last" → -1 (count from the end); null when not an ordinal. */
export function parseOrdinal(word: string): number | null {
  const w = word.trim().toLowerCase()
  if (w in ORDINALS) return ORDINALS[w]
  const m = /^(\d{1,3})(st|nd|rd|th)$/.exec(w)
  return m ? Number(m[1]) : null
}

/**
 * Visual reading order: top to bottom, then left to right. Two boxes are on the same row
 * when their vertical centres are closer than half the smaller height.
 */
export function compareReading(a: Rect, b: Rect): number {
  const ay = a.y + a.h / 2
  const by = b.y + b.h / 2
  if (Math.abs(ay - by) >= Math.min(a.h, b.h) / 2) return ay - by
  return a.x - b.x
}

export function sortReading<T>(items: T[], rectOf: (t: T) => Rect): T[] {
  return [...items].sort((a, b) => compareReading(rectOf(a), rectOf(b)))
}

/** The nth item (1-based; negative counts from the end), or undefined. */
export function pickNth<T>(items: T[], nth: number): T | undefined {
  if (nth < 0) return items[items.length + nth]
  return nth >= 1 ? items[nth - 1] : undefined
}

/**
 * Auto-correct click_nth_element n when AI sends row number instead of occurrence count.
 * Parses the AI's summary ("Row 1: Stripe, Row 4: OxGF, Row 5: OxGF, Row 6: OxGF") to
 * find which occurrence the target row corresponds to.
 * Example: AI sends n=6 for "OxGF" at row 6 (3rd OxGF) → corrects to n=3.
 */
export function correctNthElement(result: ClaudeResponse): ClaudeResponse {
  if (result.mode !== 'action' || !result.actions || !result.summary) return result

  const rowRegex = /Row\s*(\d+):\s*([^,\n]+)/gi
  const rows: Array<{ n: number; text: string }> = []
  let m: RegExpExecArray | null
  while ((m = rowRegex.exec(result.summary)) !== null) {
    rows.push({ n: parseInt(m[1]), text: m[2].trim() })
  }
  if (rows.length === 0) return result

  const corrected = result.actions.map((action) => {
    if (action.type !== 'click_nth_element' || !action.n || !action.text) return action
    const normSearch = ocrNorm(action.text)
    const targetRowN = action.n
    const matchingRows = rows.filter((r) => ocrNorm(r.text).includes(normSearch))
    const occIdx = matchingRows.findIndex((r) => r.n === targetRowN)
    if (occIdx >= 0) {
      const correctedN = occIdx + 1
      if (correctedN !== targetRowN) {
        console.log(
          `[query] correcting click_nth_element n=${targetRowN} → n=${correctedN} (row ${targetRowN} is occurrence ${correctedN} of "${action.text}")`
        )
        return { ...action, n: correctedN }
      }
    }
    return action
  })

  return { ...result, actions: corrected }
}
