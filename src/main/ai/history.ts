// Conversation history, text only (no screenshots). Honours historyEnabled / historyExchanges.
// One exchange keeps the user's words, the spoken reply, the reply mode and the labels of the
// targets it pointed at; it is sent to the main model as prior user/assistant messages.
import type { ModelResponse } from '@shared/types'
import { loadConfig } from '../config'

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export interface Exchange {
  utterance: string
  /** What the assistant said (or a one-line summary for non-answer replies). */
  spoken: string
  mode?: string
  /** Labels of the items the reply pointed at (locate items, guide steps, clicked targets). */
  targets?: string[]
}

export interface HistorySettings {
  historyEnabled: boolean
  historyExchanges: number
}

// Upper bound of the historyExchanges setting.
export const MAX_STORED_EXCHANGES = 50
const MAX_TARGET_LABELS = 6

export class ConversationHistory {
  private exchanges: Exchange[] = []

  constructor(private readonly settings: () => HistorySettings) {}

  add(exchange: Exchange): void {
    if (!this.settings().historyEnabled) return
    const targets = exchange.targets?.filter(Boolean).slice(0, MAX_TARGET_LABELS)
    this.exchanges.push({ ...exchange, targets: targets?.length ? targets : undefined })
    if (this.exchanges.length > MAX_STORED_EXCHANGES)
      this.exchanges.splice(0, this.exchanges.length - MAX_STORED_EXCHANGES)
  }

  /** Drops the most recent exchange ("forget that"); returns it. */
  dropLast(): Exchange | undefined {
    return this.exchanges.pop()
  }

  /** "New topic": the next request starts without earlier context. */
  clear(): void {
    this.exchanges = []
  }

  get size(): number {
    return this.exchanges.length
  }

  last(): Exchange | undefined {
    return this.exchanges.at(-1)
  }

  /** The most recent exchanges as chat messages, oldest first ([] when history is off). */
  messages(): HistoryEntry[] {
    const s = this.settings()
    if (!s.historyEnabled || s.historyExchanges <= 0) return []
    return this.exchanges.slice(-s.historyExchanges).flatMap((e) => [
      { role: 'user' as const, content: e.utterance },
      { role: 'assistant' as const, content: assistantText(e) }
    ])
  }
}

function assistantText(e: Exchange): string {
  const head = e.mode && e.mode !== 'answer' ? `[${e.mode}] ` : ''
  const targets = e.targets?.length ? ` (pointed at: ${e.targets.join(', ')})` : ''
  return `${head}${e.spoken}${targets}`
}

export const history = new ConversationHistory(() => loadConfig())

export function addToHistory(exchange: Exchange): void {
  history.add(exchange)
}

/** The most recent exchanges to send with a request, oldest first. */
export function historyMessages(): HistoryEntry[] {
  return history.messages()
}

/** Text-only record of one turn for the conversation history (no screenshots). */
export function historyExchange(utterance: string, result: ModelResponse): Exchange {
  const base = { utterance, mode: result.mode }
  switch (result.mode) {
    case 'answer':
      return { ...base, spoken: result.spoken ?? result.text }
    case 'action':
      return {
        ...base,
        spoken: result.summary ?? `ran ${result.actions?.map((a) => a.type).join(', ')}`,
        targets: result.actions?.flatMap((a) =>
          'description' in a && a.description ? [a.description] : []
        )
      }
    case 'guide':
      return {
        ...base,
        spoken: `showed ${result.steps?.length ?? 0} steps`,
        targets: result.steps?.map((s) => s.label)
      }
    case 'text_insert':
      return { ...base, spoken: 'inserted text' }
    default:
      return {
        ...base,
        spoken: result.notFoundReason ?? 'highlighted on screen',
        targets: result.items?.map((i) => i.label)
      }
  }
}
