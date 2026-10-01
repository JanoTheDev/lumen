// Layout and status components: Card, Kbd, NavList, ProgressBar, Toast, Thinking,
// StepList and the per-window LiveRegion.
import { useId, type ReactNode } from 'react'
import { registerRegion } from './announce'
import { icons, type IconComponent } from './icons'

// ---- Card ----

export interface CardProps {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Heading level inside the page (default 2). */
  level?: 2 | 3
  actions?: ReactNode
  id?: string
}

export function Card({
  title,
  description,
  children,
  level = 2,
  actions,
  id
}: CardProps): JSX.Element {
  const auto = useId()
  const hid = `${id ?? auto}-title`
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <section className="ui-card surface" aria-labelledby={hid} id={id}>
      <header className="ui-card__head">
        <div>
          <H id={hid} className="ui-card__title">
            {title}
          </H>
          {description && <p className="ui-card__desc">{description}</p>}
        </div>
        {actions && <div className="ui-card__actions">{actions}</div>}
      </header>
      {children && <div className="ui-card__body">{children}</div>}
    </section>
  )
}

// ---- Kbd ----

/** "Ctrl+Shift+Space" → separate <kbd>s so screen readers say "Control plus Shift plus Space". */
export function Kbd({ combo }: { combo: string }): JSX.Element {
  const keys = combo.split('+').filter(Boolean)
  return (
    <span className="ui-kbd">
      {keys.map((k, i) => (
        <span key={i}>
          {i > 0 && <span className="ui-kbd__plus"> + </span>}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  )
}

// ---- NavList ----

export interface NavItem<T extends string> {
  id: T
  label: string
  icon?: IconComponent
}

export interface NavListProps<T extends string> {
  label: string
  items: ReadonlyArray<NavItem<T>>
  current: T
  onSelect: (id: T) => void
  /** Link target prefix so items work as real links, e.g. "#/settings/". */
  hrefPrefix?: string
}

export function NavList<T extends string>({
  label,
  items,
  current,
  onSelect,
  hrefPrefix = '#/'
}: NavListProps<T>): JSX.Element {
  return (
    <nav aria-label={label} className="ui-nav">
      <ul>
        {items.map(({ id, label: text, icon: Icon }) => (
          <li key={id}>
            <a
              href={`${hrefPrefix}${id}`}
              className="ui-nav__item"
              aria-current={id === current ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                onSelect(id)
              }}
            >
              {Icon && <Icon />}
              <span>{text}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

// ---- ProgressBar ----

export interface ProgressBarProps {
  label: string
  /** 0..1; omit for indeterminate. */
  value?: number
  valueText?: string
}

export function ProgressBar({ label, value, valueText }: ProgressBarProps): JSX.Element {
  const determinate = typeof value === 'number'
  const pct = determinate ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined
  return (
    <div className="ui-progress">
      <div className="ui-progress__head">
        <span>{label}</span>
        {determinate && <span className="tabular">{valueText ?? `${pct}%`}</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={pct}
        aria-valuetext={valueText ?? (determinate ? `${pct} percent` : 'Working')}
        className={determinate ? 'ui-progress__track' : 'ui-progress__track is-indeterminate'}
      >
        <div
          className="ui-progress__fill"
          style={determinate ? { transform: `scaleX(${(pct ?? 0) / 100})` } : undefined}
        />
      </div>
    </div>
  )
}

// ---- Toast ----

export interface ToastProps {
  kind?: 'info' | 'success' | 'error'
  children: ReactNode
  action?: { label: string; onClick: () => void }
  onDismiss?: () => void
}

const TOAST_ICON = { info: icons.info, success: icons.checkCircle, error: icons.error }

export function Toast({ kind = 'info', children, action, onDismiss }: ToastProps): JSX.Element {
  const Icon = TOAST_ICON[kind]
  return (
    <div className={`ui-toast ui-toast--${kind} surface`} role="status">
      <Icon />
      <span className="ui-toast__text">{children}</span>
      {action && (
        <button type="button" className="ui-btn ui-btn--quiet ui-btn--md" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="ui-iconbtn" aria-label="Dismiss" onClick={onDismiss}>
          <icons.close />
        </button>
      )}
    </div>
  )
}

// ---- Thinking ----

export function Thinking({ label = 'Thinking' }: { label?: string }): JSX.Element {
  return (
    <span role="status" className="ui-thinking">
      <span className="ui-thinking__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}…</span>
    </span>
  )
}

// ---- StepList ----

export type StepState = 'pending' | 'active' | 'done' | 'failed'

export interface Step {
  label: string
  state: StepState
}

const STEP_TEXT: Record<StepState, string> = {
  pending: 'Not started',
  active: 'In progress',
  done: 'Done',
  failed: 'Failed'
}

export function StepList({
  steps,
  label = 'Steps',
  horizontal
}: {
  steps: ReadonlyArray<Step>
  label?: string
  horizontal?: boolean
}): JSX.Element {
  return (
    <ol className={horizontal ? 'ui-steps is-horizontal' : 'ui-steps'} aria-label={label}>
      {steps.map((s, i) => {
        const Icon =
          s.state === 'done'
            ? icons.checkCircle
            : s.state === 'failed'
              ? icons.error
              : s.state === 'active'
                ? icons.chevronRight
                : null
        return (
          <li
            key={i}
            className={`ui-steps__item is-${s.state}`}
            aria-current={s.state === 'active' ? 'step' : undefined}
          >
            <span className="ui-steps__mark" aria-hidden="true">
              {Icon ? <Icon /> : <span className="ui-steps__dot" />}
            </span>
            <span className="ui-steps__label">{s.label}</span>
            <span className="visually-hidden">, {STEP_TEXT[s.state]}</span>
          </li>
        )
      })}
    </ol>
  )
}

// ---- LiveRegion ----

/** Mount once per window; announce() writes here. */
export function LiveRegion(): JSX.Element {
  return (
    <div className="visually-hidden">
      <div ref={(el) => registerRegion('polite', el)} aria-live="polite" aria-atomic="true" />
      <div ref={(el) => registerRegion('assertive', el)} aria-live="assertive" aria-atomic="true" />
    </div>
  )
}
