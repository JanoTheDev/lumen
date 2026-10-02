// Making buddies by voice (08 T51): "make a buddy that …", the draft review ("save it",
// "call it …", "read it back", "discard it"), voice edits ("tell Inbox Buddy to also check
// Outlook") and "rename X buddy to Y". The pipeline calls buddyCreationTurn before its own
// buddy calling grammar; false = not a creation turn.

export interface BuddyTurnCtx {
  /** Speaks and shows a line on the bar (the turn's answer). */
  say(text: string): void
  /** The bar's confirm card; resolves true on yes. Left out = a spoken review only. */
  showCard?(summary: string, risk: 'low' | 'medium' | 'high'): Promise<boolean>
  /** A line under the presence rule (offers). */
  notice?(text: string): void
  /** The user is around and not in quiet mode. */
  canSpeakUp?(): boolean
  now?(): number
  log?(msg: string): void
}

/** Handles a buddy creation / review / edit turn; false when the words are not one. */
export async function buddyCreationTurn(text: string, ctx: BuddyTurnCtx): Promise<boolean> {
  void text
  void ctx
  return false
}
