import { useEffect, useId, useRef, useState } from 'react'
import { announce } from './announce'
import { Button } from './controls'
import { Countdown } from './Countdown'
import { icons } from './icons'

export interface ConfirmCardProps {
  summary: string
  risk: 'low' | 'medium' | 'high'
  /** Auto-confirm after this long. Ignored for high risk. */
  countdownMs?: number
  confirmLabel?: string
  /** Verb for the countdown text: "Sending" → "Sending in 3". */
  countdownVerb?: string
  hint?: string
  onConfirm: () => void
  onDeny: () => void
  /** Move focus into the card (when the window is focusable). */
  autoFocus?: boolean
}

type Outcome = 'pending' | 'confirmed' | 'denied'

/** Enter confirms, Escape denies. High risk never auto-confirms and focuses Stop. */
export function ConfirmCard({
  summary,
  risk,
  countdownMs,
  confirmLabel = 'Do it',
  countdownVerb = 'Continuing',
  hint = 'Say “stop” or press Esc.',
  onConfirm,
  onDeny,
  autoFocus
}: ConfirmCardProps): JSX.Element {
  const id = useId()
  const [outcome, setOutcome] = useState<Outcome>('pending')
  const stopRef = useRef<HTMLButtonElement>(null)
  const goRef = useRef<HTMLButtonElement>(null)
  const timed = risk !== 'high' && !!countdownMs

  useEffect(() => {
    if (!timed) announce(`Needs OK. ${summary}. Say yes or stop.`, 'assertive')
    if (autoFocus) (risk === 'high' ? stopRef : goRef).current?.focus()
  }, [summary, risk, timed, autoFocus])

  const confirm = (): void => {
    if (outcome !== 'pending') return
    setOutcome('confirmed')
    onConfirm()
  }
  const deny = (): void => {
    if (outcome !== 'pending') return
    setOutcome('denied')
    onDeny()
  }

  const buttons = (
    <div className="ui-confirm__actions">
      <Button ref={stopRef} variant="danger" onClick={deny} disabled={outcome !== 'pending'}>
        Stop
      </Button>
      <Button ref={goRef} variant="primary" onClick={confirm} disabled={outcome !== 'pending'}>
        {confirmLabel}
      </Button>
    </div>
  )

  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-s`}
      aria-describedby={`${id}-h`}
      className={`ui-confirm surface is-${risk}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          deny()
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          confirm()
        }
      }}
    >
      <p id={`${id}-s`} className="ui-confirm__summary">
        <icons.alert />
        <span>{summary}</span>
      </p>
      {outcome === 'pending' && timed ? (
        <Countdown
          durationMs={countdownMs}
          label={(s) => `${countdownVerb} in ${s}`}
          onDone={confirm}
          onCancel={deny}
        >
          {buttons}
        </Countdown>
      ) : outcome === 'pending' ? (
        buttons
      ) : (
        <p className="ui-confirm__result" role="status">
          {outcome === 'confirmed' ? (
            <>
              <icons.checkCircle /> Confirmed
            </>
          ) : (
            <>
              <icons.error /> Stopped
            </>
          )}
        </p>
      )}
      <p id={`${id}-h`} className="ui-hint">
        {hint}
      </p>
    </div>
  )
}
