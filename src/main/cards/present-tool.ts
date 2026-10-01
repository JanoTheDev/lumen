// The present_cards handler (05 T39) for foreground and background research tasks: checks the
// cards against what this task read (research.ts), shows them (foreground: on the bar with the
// spoken text; background: stored for the Tasks list's "View results"), looks up pictures, and
// ends the task. A refused set goes back to the model as a tool error, so it can fix it.
import type { ToolContent } from '../ai/providers/types'
import type { ToolHandler } from '../agent-mode/runner'
import { log } from '../logger'
import { findCardImages } from './find-images'
import { presentCards } from './index'
import { buildAnswerCards, observedFrom, presentCardsInput } from './research'

export interface PresentToolOptions {
  /** Background task: the cards wait in the Tasks list instead of the bar. */
  background: boolean
  /** The browser's address now (the page in front counts as read). */
  pageUrl?(): Promise<string | null>
  now?(): number
  /** Pictures for the cards (default: page og:image, else Wikimedia Commons). */
  findImages?(id: string): Promise<void>
}

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]

export function presentCardsHandler(opts: PresentToolOptions): ToolHandler {
  return async (raw, ctx) => {
    const input = presentCardsInput.safeParse(raw)
    if (!input.success)
      return {
        content: text(`Invalid present_cards input: ${input.error.issues[0]?.message ?? ''}`),
        isError: true
      }
    const page = opts.pageUrl ? await opts.pageUrl().catch(() => null) : null
    const seen = observedFrom(ctx.messages?.() ?? [], [page])
    const built = buildAnswerCards(input.data, seen, (opts.now ?? Date.now)())
    if (!built.ok) return { content: text(`Not shown: ${built.error}`), isError: true }
    const shown = presentCards(built.text, built.cards, {
      request: ctx.task().prompt,
      ...(opts.background ? { show: false, conversation: false } : {})
    })
    if (!shown.ok) return { content: text(`Not shown: ${shown.error}`), isError: true }
    if (built.dropped.length)
      log('plan', `cards: dropped ${built.dropped.length} unsourced field(s)`)
    void (opts.findImages ?? findCardImages)(shown.id).catch(() => {})
    const n = built.cards.cards.length
    const note = built.dropped.length
      ? ` Removed because they were not on a page read in this task: ${built.dropped.join('; ')}.`
      : ''
    return {
      content: text(`Shown ${n} card${n === 1 ? '' : 's'}.${note}`),
      label: `showed ${n} result${n === 1 ? '' : 's'}`,
      end: { summary: built.text, cardsId: shown.id }
    }
  }
}
