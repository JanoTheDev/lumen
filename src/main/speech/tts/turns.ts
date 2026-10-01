// Engine choice and per-turn bookkeeping for spoken replies (pure, unit-tested).

export type TtsEngine = 'windows' | 'cloud'

export function ttsEngine(pref: 'windows' | 'cloud' | 'off', openaiKey: boolean): TtsEngine | null {
  if (pref === 'off') return null
  return pref === 'cloud' && openaiKey ? 'cloud' : 'windows'
}

/** Per-turn bookkeeping: which turn is running and which turns already spoke. */
export class TurnSpeech {
  current: string | null = null
  private spoke = new Set<string>()

  start(turnId: string): void {
    this.current = turnId
  }

  markSpoken(turnId: string): void {
    this.spoke.add(turnId)
    if (this.spoke.size > 50) this.spoke.delete(this.spoke.values().next().value as string)
  }

  hasSpoken(turnId: string): boolean {
    return this.spoke.has(turnId)
  }

  end(turnId: string): void {
    if (this.current === turnId) this.current = null
  }
}
