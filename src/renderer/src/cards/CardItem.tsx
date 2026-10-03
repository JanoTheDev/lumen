// One answer card (05 Phase R). DOM order is the screen reader order: title, the kind's key line
// (recipe time / servings, product store, trip times), the stat number, price, rating, summary,
// the kind's lines (steps, timeline, pros and cons), facts, badges, source, then the buttons; the
// picture sits first visually only (CSS order). Each kind lays out its own middle; colours come
// from the card's accent (cards.css). Images are data URLs from main; nothing remote loads here.
import { memo, useId, type CSSProperties } from 'react'
import type { CardAction, CardActionKind, CardSource, CardTone, CardView } from '@shared/cards'
import { icons, type IconComponent } from '../ui'
import {
  accentAttrs,
  actionLabel,
  formatPrice,
  formatRating,
  isDataImage,
  isMainAction,
  keyLine,
  mainSource,
  primaryAction,
  restFacts,
  shortRating,
  shortSource,
  siteOf,
  sourceLine
} from './view'

const ACTION_ICON: Partial<Record<CardActionKind, IconComponent>> = {
  save: icons.bookmark,
  copy: icons.copy,
  compare: icons.columns,
  more: icons.message
}

const TONE_ICON: Record<CardTone, IconComponent> = {
  neutral: icons.info,
  info: icons.info,
  success: icons.checkCircle,
  warning: icons.alert,
  danger: icons.error
}

export interface CardItemProps {
  card: CardView
  sources: CardSource[]
  now: number
  /** Heading level inside the list (3 on the bar, 2 on the page). */
  level?: 2 | 3
  /** Index in the list from 1, for "2 of 5" labels. */
  position?: { index: number; total: number }
  /** A button: its kind, its index in the card's actions and the card's id. */
  onAction?: (kind: CardActionKind, index: number, cardId: string) => void
  /** Focus target for arrow-key moves between cards. */
  focusable?: boolean
  /**
   * The bar's strip: at most 3 facts, and only Save / Copy as icons (the strip has its own
   * Compare, and "tell me more about the second one" works by voice).
   */
  dense?: boolean
}

/** Icon buttons a dense card keeps. */
const DENSE_TOOLS = new Set<CardActionKind>(['save', 'copy'])
const DENSE_FACTS = 3

/** The icon buttons a card shows, with their indexes in its actions. */
function toolActions(actions: CardAction[], dense?: boolean): { a: CardAction; i: number }[] {
  return actions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !isMainAction(a) && (!dense || DENSE_TOOLS.has(a.kind)))
}

function CardButtons({
  actions,
  cardId,
  titleId,
  dense,
  onAction
}: {
  actions: CardAction[]
  cardId: string
  titleId: string
  dense?: boolean
  onAction: (kind: CardActionKind, index: number, cardId: string) => void
}): JSX.Element {
  const primary = primaryAction(actions)
  const main = actions.map((a, i) => ({ a, i })).filter(({ a }) => isMainAction(a))
  const tools = toolActions(actions, dense)
  return (
    <div className="cd-card__actions">
      {main.map(({ a, i }) => {
        const look = i === primary ? 'primary' : (a.style ?? 'secondary')
        const { style, ...data } = accentAttrs(a.color)
        return (
          <button
            key={i}
            type="button"
            className={`cd-btn is-${look}`}
            aria-describedby={titleId}
            title={a.kind === 'link' && a.url ? siteOf(a.url) : undefined}
            style={style as CSSProperties | undefined}
            {...data}
            onClick={() => onAction(a.kind, i, cardId)}
          >
            {actionLabel(a)}
            {(a.kind === 'link' || a.kind === 'open') && <icons.external className="cd-btn__ext" />}
          </button>
        )
      })}
      {tools.length > 0 && (
        <span className="cd-card__tools">
          {tools.map(({ a, i }) => {
            const Icon = ACTION_ICON[a.kind] ?? icons.plus
            return (
              <button
                key={i}
                type="button"
                className="cd-tool"
                aria-label={actionLabel(a)}
                aria-describedby={titleId}
                title={actionLabel(a)}
                onClick={() => onAction(a.kind, i, cardId)}
              >
                <Icon />
              </button>
            )
          })}
        </span>
      )}
    </div>
  )
}

/** The kind's own middle: steps, timeline, pros and cons, a plain list. */
function KindLines({ card }: { card: CardView }): JSX.Element | null {
  if (card.kind === 'pros-cons' && (card.pros?.length || card.cons?.length))
    return (
      <div className="cd-pc">
        {!!card.pros?.length && (
          <div className="cd-pc__col is-pro">
            <p className="cd-pc__head">Pros</p>
            <ul>
              {card.pros.map((p, i) => (
                <li key={i}>
                  <icons.check className="cd-pc__icon" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!card.cons?.length && (
          <div className="cd-pc__col is-con">
            <p className="cd-pc__head">Cons</p>
            <ul>
              {card.cons.map((c, i) => (
                <li key={i}>
                  <icons.minus className="cd-pc__icon" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  if (!card.items?.length) return null
  if (card.kind === 'steps')
    return (
      <ol className="cd-steps">
        {card.items.map((it, i) => (
          <li key={i}>
            <span className="cd-steps__n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="cd-steps__text">
              {it.label && <strong>{it.label} </strong>}
              {it.text}
            </span>
          </li>
        ))}
      </ol>
    )
  if (card.kind === 'timeline')
    return (
      <ol className="cd-timeline">
        {card.items.map((it, i) => (
          <li key={i}>
            <span className="cd-timeline__when">{it.label}</span>
            <span className="cd-timeline__what">{it.text}</span>
          </li>
        ))}
      </ol>
    )
  return (
    <ul className="cd-list">
      {card.items.map((it, i) => (
        <li key={i}>
          {it.label && <span className="cd-list__label">{it.label}</span>}
          <span>{it.text}</span>
        </li>
      ))}
    </ul>
  )
}

function CardItemView({
  card,
  sources,
  now,
  level = 3,
  position,
  onAction,
  focusable,
  dense
}: CardItemProps): JSX.Element {
  const id = useId()
  const Heading = level === 2 ? 'h2' : 'h3'
  const src = mainSource(card, sources)
  const line = keyLine(card)
  const facts = restFacts(card, line).slice(0, dense ? DENSE_FACTS : undefined)
  const tone = card.kind === 'callout' ? (card.tone ?? 'info') : undefined
  const ToneIcon = tone ? TONE_ICON[tone] : null
  const hasImage = !!card.image && isDataImage(card.image.src)
  const { style, ...accent } = accentAttrs(card.accent)
  const link = card.links[0]?.url
  // Only icon buttons: they sit in the top corner instead of taking a row of their own.
  const tools = onAction ? toolActions(card.actions, dense).length : 0
  const toolsOnly = tools > 0 && !card.actions.some(isMainAction)
  const classes = [
    'cd-card',
    `is-${card.kind}`,
    tone && `tone-${tone}`,
    (hasImage || card.imagePending) && 'has-img',
    toolsOnly && 'tools-only'
  ]
  return (
    <article
      className={classes.filter(Boolean).join(' ')}
      aria-labelledby={`${id}-t`}
      tabIndex={focusable ? -1 : undefined}
      data-card={card.id}
      style={{ ...(style as CSSProperties | undefined), '--cd-tools': tools } as CSSProperties}
      {...accent}
    >
      <div className="cd-card__body">
        <div className="cd-card__head">
          {ToneIcon && <ToneIcon className="cd-card__tone" />}
          <div className="cd-card__titles">
            {card.kind === 'link' && link && <p className="cd-card__site">{siteOf(link)}</p>}
            <Heading id={`${id}-t`} className="cd-card__title">
              {card.title}
              {position && (
                <span className="visually-hidden">
                  , {position.index} of {position.total}
                </span>
              )}
            </Heading>
            {card.subtitle && (
              <p className={`cd-card__sub${card.kind === 'entity' ? ' is-oneline' : ''}`}>
                {card.subtitle}
              </p>
            )}
          </div>
        </div>
        {line.items.length > 0 && (
          <p className="cd-card__key">
            {line.items.map((item, i) => (
              <span key={item}>
                {i > 0 && <span aria-hidden="true"> · </span>}
                {i > 0 && <span className="visually-hidden">, </span>}
                {item}
              </span>
            ))}
          </p>
        )}
        {card.value && (
          <div className="cd-stat">
            <p className="cd-stat__value">
              {card.value.text}
              {(card.value.change || card.value.trend) && (
                <span className={`cd-stat__change is-${card.value.trend ?? 'flat'}`}>
                  {card.value.trend === 'up' && <icons.trendUp />}
                  {card.value.trend === 'down' && <icons.trendDown />}
                  {card.value.change}
                </span>
              )}
            </p>
            {card.value.caption && <p className="cd-stat__caption">{card.value.caption}</p>}
          </div>
        )}
        {(card.price || card.rating) && (
          <p className="cd-card__meta">
            {card.price && (
              <span className="cd-card__price">
                <span className="visually-hidden">Price: </span>
                {formatPrice(card.price)}
              </span>
            )}
            {card.rating && (
              <span className="cd-card__rating">
                <span className="cd-card__star" aria-hidden="true">
                  ★{' '}
                </span>
                <span className="visually-hidden">Rated {formatRating(card.rating)}</span>
                <span aria-hidden="true">{shortRating(card.rating)}</span>
              </span>
            )}
          </p>
        )}
        {card.price?.note && <p className="cd-card__note">{card.price.note}</p>}
        {card.summary && (
          <p className="cd-card__summary">
            {card.summary.text} <span className="cd-card__credit">From {card.summary.source}</span>
          </p>
        )}
        <KindLines card={card} />
        {facts.length > 0 && (
          <dl className="cd-card__facts">
            {facts.map((f) => (
              <div key={f.label} className="cd-card__fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {!!card.badges?.length && (
          <ul className="cd-card__badges" aria-label="Highlights">
            {card.badges.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {src && (
          <p className="cd-card__source">
            <span className="visually-hidden">{sourceLine(src, now)}</span>
            <span aria-hidden="true">{shortSource(src, now)}</span>
          </p>
        )}
        {card.image?.attribution && <p className="cd-card__credit">{card.image.attribution}</p>}
        {onAction && card.actions.length > 0 && (
          <CardButtons
            actions={card.actions}
            cardId={card.id}
            titleId={`${id}-t`}
            dense={dense}
            onAction={onAction}
          />
        )}
      </div>
      {hasImage ? (
        <img
          className="cd-card__img"
          src={card.image!.src}
          alt={card.image!.alt}
          decoding="async"
        />
      ) : card.imagePending ? (
        <div className="cd-card__img is-pending" aria-hidden="true" />
      ) : null}
    </article>
  )
}

const sameProps = (a: CardItemProps, b: CardItemProps): boolean =>
  a.card === b.card &&
  a.sources === b.sources &&
  a.now === b.now &&
  a.level === b.level &&
  a.position?.index === b.position?.index &&
  a.position?.total === b.position?.total &&
  a.onAction === b.onAction &&
  a.focusable === b.focusable &&
  a.dense === b.dense

export const CardItem = memo(CardItemView, sameProps)
