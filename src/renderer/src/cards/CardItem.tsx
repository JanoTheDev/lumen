// One answer card (05 Phase R). DOM order is the screen reader order: title, the kind's key line
// (recipe time / servings, product store, trip times), price, rating, summary, facts, badges,
// source, then the buttons; the picture sits first visually only (CSS order).
// Images are data URLs from main; nothing remote loads here.
import { useId } from 'react'
import type { CardActionKind, CardSource, CardView } from '@shared/cards'
import {
  formatPrice,
  formatRating,
  isDataImage,
  keyLine,
  mainSource,
  restFacts,
  sourceLine
} from './view'

const ACTION_LABEL: Record<Exclude<CardActionKind, 'do'>, string> = {
  open: 'Open',
  save: 'Save',
  compare: 'Compare',
  more: 'More'
}

export interface CardItemProps {
  card: CardView
  sources: CardSource[]
  now: number
  /** Heading level inside the list (3 on the bar, 2 on the page). */
  level?: 2 | 3
  /** Index in the list from 1, for "2 of 5" labels. */
  position?: { index: number; total: number }
  onAction?: (kind: CardActionKind) => void
  /** Focus target for arrow-key moves between cards. */
  focusable?: boolean
}

export function CardItem({
  card,
  sources,
  now,
  level = 3,
  position,
  onAction,
  focusable
}: CardItemProps): JSX.Element {
  const id = useId()
  const Heading = level === 2 ? 'h2' : 'h3'
  const src = mainSource(card, sources)
  const line = keyLine(card)
  const facts = restFacts(card, line)
  return (
    <article
      className={`cd-card is-${card.kind}`}
      aria-labelledby={`${id}-t`}
      tabIndex={focusable ? -1 : undefined}
      data-card={card.id}
    >
      <div className="cd-card__body">
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
        {card.price && (
          <p className="cd-card__price">
            <span className="visually-hidden">Price: </span>
            {formatPrice(card.price)}
            {card.price.note && <span className="cd-card__note"> · {card.price.note}</span>}
          </p>
        )}
        {card.rating && (
          <p className="cd-card__rating">
            <span aria-hidden="true">★ </span>
            <span className="visually-hidden">Rated </span>
            {formatRating(card.rating)}
          </p>
        )}
        {card.summary && (
          <p className="cd-card__summary">
            {card.summary.text} <span className="cd-card__credit">From {card.summary.source}</span>
          </p>
        )}
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
        {src && <p className="cd-card__source">{sourceLine(src, now)}</p>}
        {card.image?.attribution && <p className="cd-card__credit">{card.image.attribution}</p>}
        {onAction && card.actions.length > 0 && (
          <div className="cd-card__actions">
            {card.actions.map((a) => (
              <button
                key={a.kind}
                type="button"
                className={`cd-card__btn${a.kind === 'do' ? ' is-do' : ''}`}
                aria-describedby={`${id}-t`}
                onClick={() => onAction(a.kind)}
              >
                {a.kind === 'do' ? (a.label ?? 'Do it') : ACTION_LABEL[a.kind]}
              </button>
            ))}
          </div>
        )}
      </div>
      {card.image && isDataImage(card.image.src) ? (
        <img className="cd-card__img" src={card.image.src} alt={card.image.alt} />
      ) : card.imagePending ? (
        <div className="cd-card__img is-pending" aria-hidden="true" />
      ) : null}
    </article>
  )
}
