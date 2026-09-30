// Conversation history, text only (no images). Honours historyEnabled / historyExchanges.
import { loadConfig } from '../config'

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

// Upper bound of the historyExchanges setting.
const MAX_STORED_EXCHANGES = 50

const entries: HistoryEntry[] = []

export function addToHistory(userPrompt: string, assistantSummary: string): void {
  if (!loadConfig().historyEnabled) return
  entries.push(
    { role: 'user', content: userPrompt },
    { role: 'assistant', content: assistantSummary }
  )
  if (entries.length > MAX_STORED_EXCHANGES * 2)
    entries.splice(0, entries.length - MAX_STORED_EXCHANGES * 2)
}

export function clearHistory(): void {
  entries.length = 0
}

/** The most recent exchanges to send with a request, oldest first. */
export function historyMessages(): HistoryEntry[] {
  const cfg = loadConfig()
  if (!cfg.historyEnabled || cfg.historyExchanges <= 0) return []
  return entries.slice(-cfg.historyExchanges * 2).map((e) => ({ ...e }))
}
