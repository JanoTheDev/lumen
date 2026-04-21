import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
}

const MOD_LABEL: Record<string, string> = { Control: 'Ctrl', Meta: 'Super', Alt: 'Alt', Shift: 'Shift' }
const ALLOWED_SINGLE = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'])

export function HotkeyCapture({ value, onChange }: Props): JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [preview, setPreview] = useState<string>('')
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!capturing) return
    btnRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(false)
        setPreview('')
        return
      }
      const mods: string[] = []
      if (e.ctrlKey) mods.push(MOD_LABEL.Control)
      if (e.altKey) mods.push(MOD_LABEL.Alt)
      if (e.shiftKey) mods.push(MOD_LABEL.Shift)
      if (e.metaKey) mods.push(MOD_LABEL.Meta)

      const key = e.key
      const isMod = ['Control', 'Alt', 'Shift', 'Meta'].includes(key)
      if (isMod) {
        setPreview(mods.join('+') + '+…')
        return
      }

      let keyLabel = key.length === 1 ? key.toUpperCase() : key
      if (keyLabel === ' ') keyLabel = 'Space'

      // Require at least one modifier for printable keys, or F-keys alone
      if (mods.length === 0 && !ALLOWED_SINGLE.has(keyLabel)) {
        setPreview('Need a modifier (Ctrl/Alt/Shift)')
        return
      }

      const combo = mods.length ? [...mods, keyLabel].join('+') : keyLabel
      onChange(combo)
      setCapturing(false)
      setPreview('')
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, onChange])

  return (
    <div className="hotkey-capture">
      <button
        ref={btnRef}
        className={`hotkey-btn ${capturing ? 'capturing' : ''}`}
        onClick={() => { setCapturing(v => !v); setPreview('') }}
        type="button"
      >
        {capturing
          ? (preview || 'Press keys…  (Esc to cancel)')
          : (value || 'Click to set')}
      </button>
      <small className="hotkey-hint">
        {capturing ? 'Capturing — press any combination' : 'Global hotkey. Must include Ctrl/Alt/Shift or be F1–F12.'}
      </small>
    </div>
  )
}
