// Answer card: the answer view of the assistant bar.
import type { EventChannel, EventChannels } from '@shared/channels'
import * as assistant from './assistant'

/** A different answer is a new card; it does not inherit the pin of the one before. */
export function showText(text: string): void {
  const cur = assistant.state().answer
  if (cur?.pinned && cur.markdown !== text) assistant.pinAnswer(false)
  assistant.showAnswer(text)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  if (channel === 'answer:text') showText(args[0] as string)
  else assistant.send(channel, ...args)
}
