// Confirm-with-countdown for a pending action (state.confirm). The countdown pauses on hover
// and focus; high risk has no countdown and waits for an explicit choice. Main announces it
// (06 T11); a confirm that waits takes focus (Enter / Esc answer it once the bar has focus).
import type { AssistantView } from '@shared/channels'
import { ConfirmCard } from '../ui'
import { send } from '../lib/ipc'

export function Confirm({
  confirm
}: {
  confirm: NonNullable<AssistantView['confirm']>
}): JSX.Element {
  const timed = confirm.risk !== 'high' && !!confirm.countdownMs
  return (
    <ConfirmCard
      key={confirm.actionId}
      summary={confirm.summary}
      risk={confirm.risk}
      countdownMs={timed ? confirm.countdownMs : undefined}
      confirmLabel="Do it"
      countdownVerb="Doing it"
      autoFocus={!timed}
      onConfirm={() => send('assistant:command', { type: 'confirm', turnId: confirm.actionId })}
      onDeny={() => send('assistant:command', { type: 'deny', turnId: confirm.actionId })}
    />
  )
}
