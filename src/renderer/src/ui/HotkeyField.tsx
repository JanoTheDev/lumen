import { useId, useState, type KeyboardEvent } from 'react'
import { announce } from './announce'
import { Kbd } from './display'
import { comboFromEvent } from './hotkey'

const spoken = (combo: string): string => combo.split('+').join(' plus ')

export interface HotkeyFieldProps {
  label: string
  value: string
  onCommit: (combo: string) => void
  hint?: string
}

/**
 * Press the button, then the shortcut. Escape cancels, Tab keeps the current one and
 * moves on (Tab is never swallowed).
 */
export function HotkeyField({ label, value, onCommit, hint }: HotkeyFieldProps): JSX.Element {
  const id = useId()
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState('')
  const [problem, setProblem] = useState('')

  const stop = (): void => {
    setRecording(false)
    setPreview('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return
    if (e.key === 'Tab') {
      stop()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stop()
      announce('Kept the current shortcut')
      return
    }
    const r = comboFromEvent(e)
    if ('partial' in r) {
      setPreview(r.partial ? `${r.partial}+…` : '')
    } else if ('problem' in r) {
      setProblem(r.problem)
      announce(r.problem, 'assertive')
    } else {
      stop()
      setProblem('')
      onCommit(r.combo)
      announce(`Shortcut set to ${spoken(r.combo)}`)
    }
  }

  return (
    <div className="ui-field">
      <span id={`${id}-label`} className="ui-field__label">
        {label}
      </span>
      <button
        type="button"
        className={recording ? 'ui-hotkey is-recording' : 'ui-hotkey'}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-describedby={`${id}-hint`}
        onClick={() => {
          if (recording) {
            stop()
            return
          }
          setRecording(true)
          setProblem('')
          announce(
            'Recording shortcut. Press the keys, Escape to cancel, Tab to keep the current one.',
            'assertive'
          )
        }}
        onKeyDown={onKeyDown}
        onBlur={stop}
      >
        <span id={`${id}-value`}>
          {recording ? (
            <span>{preview || 'Press keys…'}</span>
          ) : value ? (
            <Kbd combo={value} />
          ) : (
            'Not set'
          )}
        </span>
      </button>
      <span id={`${id}-hint`} className={problem ? 'ui-field__error' : 'ui-hint'}>
        {problem ||
          (recording
            ? 'Press keys… (Esc to cancel, Tab to keep current)'
            : (hint ?? 'Select to change.'))}
      </span>
    </div>
  )
}
