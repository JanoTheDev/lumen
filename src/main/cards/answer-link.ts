// The bar shows a task's reply through `answer:show` (text only). A reply whose text matches cards
// presented a moment ago gets those cards again, so the card strip survives the hand-off from
// the agent task to the bar. Pure.

export const ANSWER_LINK_MS = 10 * 60_000
const KEEP = 20

const links = new Map<string, { id: string; at: number }>()

const key = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function rememberAnswer(text: string, id: string, now = Date.now()): void {
  const k = key(text)
  if (!k) return
  links.delete(k)
  links.set(k, { id, at: now })
  while (links.size > KEEP) {
    const oldest = links.keys().next().value
    if (oldest === undefined) break
    links.delete(oldest)
  }
}

/** The card set shown with this answer text in the last few minutes, if any. */
export function cardsForAnswer(text: string, now = Date.now()): string | undefined {
  const hit = links.get(key(text))
  return hit && now - hit.at <= ANSWER_LINK_MS ? hit.id : undefined
}
