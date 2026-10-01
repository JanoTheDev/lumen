// Wires "Book it for me" (05 T41): the real ports of cards/book and the card strip's Book
// button (`cards.do`) → startBooking.
import { announce } from '../a11y'
import { executeActions } from '../actions/executor'
import { requireAgent } from '../agent/instance'
import { bus } from '../bus'
import { beginScope, endScope } from '../query/cancel'
import { windowOnlyContext } from '../query/context'
import * as assistant from '../windows/assistant'
import { setBookPorts, startBooking } from './book'
import { presentCards, store } from './index'

let installed = false

export function installBooking(): void {
  if (installed) return
  installed = true
  setBookPorts({
    // The agent-mode session loads on first use (it pulls in the whole runner).
    busy: async () => (await import('../agent-mode/session')).agentRunning(),
    async openUrl(url) {
      const r = await executeActions([{ type: 'open_url', url }], {
        origin: 'user-direct',
        preview: false
      })
      return !r.denied && !r.blocked && r.executed > 0
    },
    async run(goal, opts, signal) {
      const window = await requireAgent()
        .activeWindow()
        .catch(() => '')
      const { runAgentTask } = await import('../agent-mode/session')
      return runAgentTask(goal, windowOnlyContext(window), signal, opts)
    },
    present: (text, cards) => presentCards(text, cards),
    say(text) {
      assistant.showAnswer(text)
      announce(text, { kind: 'command' })
    },
    scope() {
      const s = beginScope()
      return { signal: s.signal, end: () => endScope(s) }
    }
  })
  bus.on('cards.do', (e) => {
    const set = store.get(e.id)
    const card = set?.cards.cards.find((c) => c.id === e.cardId)
    if (set && card) void startBooking(card, { cards: set.cards, userText: e.label })
  })
}
