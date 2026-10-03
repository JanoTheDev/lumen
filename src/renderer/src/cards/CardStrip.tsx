// The bar's card strip (05 T37): a carousel of answer cards under the answer text. Up to three
// cards show at once (one card spans the width, two share it); arrow buttons and Left / Right
// move through more, and Tab into a card brings it into view. The nav row is there only when
// there is somewhere to go. Simple mode shows one card at a time with Back / Next and reads it.
// The track slides with a transform (compositor only); reduced motion makes it a jump. Only the
// window and one card on each side are drawn; the other positions are empty items of the same
// width, so the transform and Tab / arrow moves work as if every card were there.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react'
import type { CardActionKind, CardsView } from '@shared/cards'
import { Button, IconButton, icons } from '../ui'
import { CardItem } from './CardItem'
import './cards.css'
import { runCardAction, useCardsView } from './useCards'
import { readOrder, windowStart } from './view'

export const STRIP_VISIBLE = 3

/** Indexes [from, to) of the cards drawn for a window starting at `first`. */
function mountedRange(first: number, visible: number, total: number): [number, number] {
  return [Math.max(0, first - 1), Math.min(total, first + visible + 1)]
}

export interface CardStripViewProps {
  view: CardsView
  simple?: boolean
  now?: number
  /** First card of the window when the strip appears. */
  initialStart?: number
  onAction: (kind: CardActionKind | 'show-all', cardId?: string, index?: number) => void
  /** Last action result, read out politely. */
  message?: string
}

export function CardStripView({
  view,
  simple,
  now: nowProp,
  initialStart = 0,
  onAction,
  message
}: CardStripViewProps): JSX.Element {
  const [clock] = useState(Date.now)
  const now = nowProp ?? clock
  const total = view.cards.length
  const [start, setStart] = useState(initialStart)
  const [one, setOne] = useState(0)
  const [spoken, setSpoken] = useState('')
  const listRef = useRef<HTMLUListElement>(null)
  const visible = simple ? 1 : Math.min(STRIP_VISIBLE, Math.max(1, total))
  const first = simple ? Math.min(one, total - 1) : windowStart(start, start, total, visible)
  const showAll = !simple && (total > STRIP_VISIBLE || (view.layout === 'table' && total > 1))
  const paged = total > visible
  const actionRef = useRef(onAction)
  useEffect(() => {
    actionRef.current = onAction
  })
  const onCardAction = useCallback(
    (kind: CardActionKind, index: number, cardId: string) => actionRef.current(kind, cardId, index),
    []
  )

  const focusCard = (i: number): void => {
    const el = listRef.current?.children[i]?.querySelector<HTMLElement>('[data-card]')
    el?.focus({ preventScroll: true })
  }
  const move = (dir: number): void => {
    if (simple) {
      const next = Math.min(Math.max(0, one + dir), total - 1)
      setOne(next)
      setSpoken(readOrder(view.cards[next], view.sources, now).join('. '))
      return
    }
    setStart(windowStart(first + dir, first + dir, total, visible))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const items = Array.from(listRef.current?.children ?? [])
    const at = items.findIndex((el) => el.contains(document.activeElement))
    if (at < 0) return
    e.preventDefault()
    e.stopPropagation()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    if (simple) {
      move(dir)
      requestAnimationFrame(() => focusCard(0))
      return
    }
    const next = Math.min(Math.max(0, at + dir), total - 1)
    setStart((s) => windowStart(s, next, total, visible))
    focusCard(next)
  }

  const shown = simple ? [view.cards[first]] : view.cards
  const [from, to] = simple ? [0, 1] : mountedRange(first, visible, total)
  return (
    <section
      className={`cd-strip${simple ? ' is-simple' : ''}`}
      aria-label="Results"
      style={{ '--cd-cols': visible } as CSSProperties}
    >
      <div className="cd-strip__viewport">
        <ul
          ref={listRef}
          role="list"
          className="cd-strip__track"
          aria-label={`${total} result${total === 1 ? '' : 's'}`}
          onKeyDown={onKeyDown}
          style={
            simple
              ? undefined
              : { transform: `translateX(calc(${-first} * (100% + var(--cd-gap)) / ${visible}))` }
          }
        >
          {shown.map((card, k) => {
            const i = simple ? first : k
            const off = !simple && (i < first || i >= first + visible)
            if (k < from || k >= to)
              return <li key={card.id} className="cd-strip__item is-off" aria-hidden="true" />
            return (
              <li
                key={card.id}
                role="listitem"
                className={`cd-strip__item${off ? ' is-off' : ''}`}
                onFocus={() => {
                  if (!simple) setStart((s) => windowStart(s, i, total, visible))
                }}
              >
                <CardItem
                  card={card}
                  sources={view.sources}
                  now={now}
                  position={{ index: i + 1, total }}
                  focusable
                  dense
                  onAction={onCardAction}
                />
              </li>
            )
          })}
        </ul>
      </div>
      {(paged || showAll) && (
        <div className="cd-strip__nav">
          {paged && (
            <>
              {simple ? (
                <Button icon={icons.arrowLeft} disabled={first === 0} onClick={() => move(-1)}>
                  Back
                </Button>
              ) : (
                <IconButton
                  icon={icons.arrowLeft}
                  label="Previous results"
                  disabled={first === 0}
                  onClick={() => move(-1)}
                />
              )}
              <span className="cd-strip__count" aria-hidden={simple ? undefined : true}>
                {simple
                  ? `${first + 1} of ${total}`
                  : `${first + 1}–${Math.min(first + visible, total)} of ${total}`}
              </span>
              {simple ? (
                <Button
                  icon={icons.arrowRight}
                  disabled={first + 1 >= total}
                  onClick={() => move(1)}
                >
                  Next
                </Button>
              ) : (
                <IconButton
                  icon={icons.arrowRight}
                  label="More results"
                  disabled={first + visible >= total}
                  onClick={() => move(1)}
                />
              )}
            </>
          )}
          {showAll && (
            <button type="button" className="cd-strip__all" onClick={() => onAction('show-all')}>
              {total > STRIP_VISIBLE ? `Show all ${total}` : 'Compare'}
            </button>
          )}
        </div>
      )}
      <p className="visually-hidden" aria-live="polite">
        {message || spoken}
      </p>
    </section>
  )
}

/** The strip for the bar's answer: loads the card set and runs the buttons through main. */
export function CardStrip({ id, simple }: { id: string; simple?: boolean }): JSX.Element | null {
  const { view } = useCardsView(id)
  const [message, setMessage] = useState('')
  if (!view || !view.cards.length) return null
  return (
    <CardStripView
      view={view}
      simple={simple}
      message={message}
      onAction={(action, cardId, index) => {
        void runCardAction({ id, cardId, action, ...(index !== undefined ? { index } : {}) }).then(
          (r) => setMessage(r.message ?? '')
        )
      }}
    />
  )
}
