import type { ClaudeResponse } from './claude'

/** Normalize OCR-confusable characters (mirrors Python _ocr_norm). */
export function ocrNorm(s: string): string {
  return s.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/i/g, 'l')
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
