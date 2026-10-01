// A one-key capture for switch keys: press the button, then the key your switch sends.
// Escape cancels, Tab keeps the current key and moves on.
import { useId, useState, type KeyboardEvent } from 'react'
import { Kbd, announce } from '../../../ui'
import { switchKeyFromEvent } from './AccessibilitySwitch'

export interface SwitchKeyFieldProps {
  label: string
  value: string
  /** Returns a problem to show instead of saving, or '' when the key was taken. */
  onCommit: (key: string) => string
  hint?: string
}

export function SwitchKeyField({ label, value, onCommit, hint }: SwitchKeyFieldProps): JSX.Element {
  const id = useId()
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState('')

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording || e.key === 'Tab') {
      setRecording(false)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(false)
      announce('Kept the current key')
      return
    }
    const r = switchKeyFromEvent(e)
    const why = 'problem' in r ? r.problem : onCommit(r.key)
    setProblem(why)
    if (why) {
      announce(why, 'assertive')
      return
    }
    setRecording(false)
    if ('key' in r) announce(`Switch key set to ${r.key}`)
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
          setProblem('')
          setRecording((r) => !r)
          if (!recording)
            announce(
              'Press your switch, or the key it sends. Escape to cancel, Tab to keep the current one.',
              'assertive'
            )
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
      >
        <span id={`${id}-value`}>
          {recording ? <span>Press your switch…</span> : <Kbd combo={value} />}
        </span>
      </button>
      <span id={`${id}-hint`} className={problem ? 'ui-field__error' : 'ui-hint'}>
        {problem ||
          (recording
            ? 'Press one key (Esc to cancel, Tab to keep the current one)'
            : (hint ?? 'Select, then press your switch.'))}
      </span>
    </div>
  )
}
