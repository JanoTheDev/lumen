// Form controls built on native elements. States and ARIA follow design-language.md §5.
import {
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import { announce } from './announce'
import { parseClamped, useDraft } from './draft'
import type { IconComponent } from './icons'

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ')

// ---- Button ----

type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: 'primary' | 'quiet' | 'danger' | 'secondary'
  size?: 'md' | 'lg'
  busy?: boolean
  icon?: IconComponent
  ref?: Ref<HTMLButtonElement>
}

/** A labelled button, or an icon-only one that must carry an aria-label. */
export type ButtonProps = ButtonBase &
  ({ children: ReactNode } | { children?: undefined; 'aria-label': string })

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  icon: Icon,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, className)}
      aria-busy={busy || undefined}
      disabled={disabled}
      {...rest}
    >
      {Icon && <Icon />}
      {children !== undefined && <span>{children}</span>}
    </button>
  )
}

// ---- IconButton ----

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  icon: IconComponent
  label: string
  /** Shortcut shown in the tooltip, e.g. "Ctrl+C". */
  shortcut?: string
  pressed?: boolean
  variant?: 'quiet' | 'danger'
}

export function IconButton({
  icon: Icon,
  label,
  shortcut,
  pressed,
  variant = 'quiet',
  className,
  type = 'button',
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <span className="ui-tip">
      <button
        type={type}
        className={cx('ui-iconbtn', variant === 'danger' && 'ui-iconbtn--danger', className)}
        aria-label={label}
        aria-pressed={pressed}
        {...rest}
      >
        <Icon />
      </button>
      <span className="ui-tip__bubble" aria-hidden="true">
        {label}
        {shortcut && <span className="ui-tip__kbd"> {shortcut.split('+').join(' + ')}</span>}
      </span>
    </span>
  )
}

// ---- Switch ----

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
  id?: string
}

export function Switch({ checked, onChange, label, hint, disabled, id }: SwitchProps): JSX.Element {
  const auto = useId()
  const base = id ?? auto
  return (
    <div className={cx('ui-switch', disabled && 'is-disabled')}>
      <button
        id={base}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${base}-label`}
        aria-describedby={hint ? `${base}-hint` : undefined}
        disabled={disabled}
        className="ui-switch__track"
        onClick={() => onChange(!checked)}
      >
        <span className="ui-switch__thumb" />
      </button>
      <span className="ui-switch__text">
        <label id={`${base}-label`} htmlFor={base} className="ui-switch__label">
          {label}
        </label>
        {hint && (
          <span id={`${base}-hint`} className="ui-hint">
            {hint}
          </span>
        )}
      </span>
    </div>
  )
}

// ---- Field ----

export interface FieldA11y {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: (a11y: FieldA11y) => ReactNode
  /** Extra content beside the label (e.g. a Test button). */
  aside?: ReactNode
}

export function Field({ label, hint, error, children, aside }: FieldProps): JSX.Element {
  const id = useId()
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className={cx('ui-field', !!error && 'is-error')}>
      <div className="ui-field__head">
        <label htmlFor={id} className="ui-field__label">
          {label}
        </label>
        {aside}
      </div>
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined
      })}
      {hint && (
        <span id={`${id}-hint`} className="ui-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="ui-field__error">
          {error}
        </span>
      )}
    </div>
  )
}

// ---- TextField ----

export interface TextFieldProps {
  label: ReactNode
  value: string
  onCommit: (v: string) => void
  hint?: ReactNode
  placeholder?: string
  multiline?: boolean
  /** Reject a draft (it reverts on blur). */
  accept?: (v: string) => boolean
  error?: ReactNode
  type?: 'text' | 'password' | 'url'
  /** Announce "Saved" after a commit. */
  announceSave?: boolean
  mono?: boolean
  spellCheck?: boolean
  /** Save only on blur or Enter (for settings that restart something). */
  commitOnBlurOnly?: boolean
}

/** Local draft; commits on blur, Enter or a 500ms pause. */
export function TextField({
  label,
  value,
  onCommit,
  hint,
  placeholder,
  multiline,
  accept,
  error,
  type = 'text',
  announceSave = true,
  mono,
  spellCheck,
  commitOnBlurOnly
}: TextFieldProps): JSX.Element {
  const draft = useDraft(
    value,
    (v) => {
      onCommit(v)
      if (announceSave) announce('Saved')
    },
    { accept, delay: commitOnBlurOnly ? null : undefined }
  )
  const invalid = accept ? !accept(draft.value) : false
  return (
    <Field label={label} hint={hint} error={error ?? (invalid ? 'Not valid yet' : undefined)}>
      {(a) =>
        multiline ? (
          <textarea
            {...a}
            className={cx('ui-input', 'ui-input--multi', mono && 'ui-input--mono')}
            value={draft.value}
            placeholder={placeholder}
            spellCheck={spellCheck}
            onChange={(e) => draft.onChange(e.target.value)}
            onBlur={draft.onBlur}
          />
        ) : (
          <input
            {...a}
            type={type}
            className={cx('ui-input', mono && 'ui-input--mono')}
            value={draft.value}
            placeholder={placeholder}
            spellCheck={spellCheck}
            onChange={(e) => draft.onChange(e.target.value)}
            onBlur={draft.onBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') draft.flush()
            }}
          />
        )
      }
    </Field>
  )
}

// ---- NumberField ----

export interface NumberFieldProps {
  label: ReactNode
  value: number
  onCommit: (v: number) => void
  min: number
  max: number
  step?: number
  unit?: string
  hint?: ReactNode
}

/** Free typing; clamps on commit (blur, Enter), never per keystroke. */
export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  unit,
  hint
}: NumberFieldProps): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [clamped, setClamped] = useState(false)
  const commit = (raw: string | null): void => {
    setText(null)
    if (raw === null) return
    const v = parseClamped(raw, min, max)
    if (v === null) return
    setClamped(v !== Number(raw.trim()))
    if (v !== value) {
      onCommit(v)
      announce(v !== Number(raw.trim()) ? `Saved as ${v}` : 'Saved')
    }
  }
  const nudge = (dir: 1 | -1): void => {
    const base = text !== null ? (parseClamped(text, min, max) ?? value) : value
    const next = Math.min(max, Math.max(min, base + dir * step))
    setText(null)
    setClamped(false)
    if (next !== value) onCommit(next)
  }
  const range = `${min}–${max}${unit ? ` ${unit}` : ''}`
  const fullHint = hint ? (
    <>
      {hint} Range {range}.
    </>
  ) : (
    `Range ${range}.`
  )
  return (
    <Field label={label} hint={clamped ? `Adjusted to fit ${range}.` : fullHint}>
      {(a) => (
        <span className="ui-number">
          <input
            {...a}
            role="spinbutton"
            inputMode="numeric"
            className="ui-input ui-input--number tabular"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={unit ? `${value} ${unit}` : String(value)}
            value={text ?? String(value)}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commit(text)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') commit(text)
              else if (e.key === 'ArrowUp') {
                e.preventDefault()
                nudge(1)
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                nudge(-1)
              }
            }}
          />
          {unit && (
            <span className="ui-number__unit" aria-hidden="true">
              {unit}
            </span>
          )}
        </span>
      )}
    </Field>
  )
}

// ---- Slider ----

export interface SliderProps {
  label: ReactNode
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  hint?: ReactNode
  disabled?: boolean
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format = String,
  hint,
  disabled
}: SliderProps): JSX.Element {
  return (
    <Field label={label} hint={hint}>
      {(a) => (
        <span className="ui-slider">
          <input
            {...a}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-valuetext={format(value)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <output htmlFor={a.id} className="ui-slider__value tabular">
            {format(value)}
          </output>
        </span>
      )}
    </Field>
  )
}

// ---- Select ----

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectProps<T extends string> {
  label: ReactNode
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (v: T) => void
  hint?: ReactNode
  disabled?: boolean
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled
}: SelectProps<T>): JSX.Element {
  return (
    <Field label={label} hint={hint}>
      {(a) => (
        <select
          {...a}
          className="ui-select"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

// ---- SegmentedControl ----

export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<SelectOption<T> & { swatch?: string }>
  onChange: (v: T) => void
  /** Hide the group label visually (it stays the accessible name). */
  hideLabel?: boolean
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel
}: SegmentedControlProps<T>): JSX.Element {
  const id = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (from: number, dir: number): void => {
    const next = (from + dir + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div className="ui-seg-wrap">
      <span id={`${id}-label`} className={hideLabel ? 'visually-hidden' : 'ui-field__label'}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="ui-seg">
        {options.map((o, i) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (!options.some((x) => x.value === value) && i === 0) ? 0 : -1}
              className={cx('ui-seg__item', selected && 'is-selected')}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  move(i, 1)
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  move(i, -1)
                }
              }}
            >
              {o.swatch && (
                <span
                  className="ui-seg__swatch"
                  style={{ background: o.swatch }}
                  aria-hidden="true"
                />
              )}
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
