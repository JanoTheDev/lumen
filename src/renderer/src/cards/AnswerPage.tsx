// Panel route #/answer/<id>[/table] (05 T37): every card of an answer as a grid or a table,
// sorted by price or rating and narrowed by the filter chips the answer suggested.
import { useMemo, useState } from 'react'
import type { CardActionKind, CardFilter, CardsView } from '@shared/cards'
import { SegmentedControl, Select, icons } from '../ui'
import { CardItem } from './CardItem'
import './cards.css'
import { runCardAction, useCardsView } from './useCards'
import {
  factColumns,
  factValue,
  filterCards,
  formatPrice,
  formatRating,
  mainSource,
  sortCards,
  sourceLine,
  type CardSort
} from './view'

export type AnswerLayout = 'grid' | 'table'

const SORTS: ReadonlyArray<{ value: CardSort; label: string }> = [
  { value: 'relevance', label: 'Best match' },
  { value: 'price', label: 'Price, low to high' },
  { value: 'rating', label: 'Rating, high to low' }
]

export interface AnswerPageViewProps {
  view: CardsView
  layout: AnswerLayout
  onLayout: (l: AnswerLayout) => void
  now?: number
  onAction: (kind: CardActionKind, cardId: string) => void
  message?: string
  /** Initial state (tests). */
  initialSort?: CardSort
  initialFilters?: string[]
}

export function AnswerPageView({
  view,
  layout,
  onLayout,
  now: nowProp,
  onAction,
  message,
  initialSort = 'relevance',
  initialFilters = []
}: AnswerPageViewProps): JSX.Element {
  const [clock] = useState(Date.now)
  const now = nowProp ?? clock
  const [sort, setSort] = useState<CardSort>(initialSort)
  const [active, setActive] = useState<string[]>(initialFilters)
  const chips: CardFilter[] = view.filters
  const cards = useMemo(() => {
    const on = chips.filter((c) => active.includes(c.label))
    return sortCards(filterCards(view.cards, on), sort)
  }, [view.cards, chips, active, sort])
  const columns = factColumns(cards)
  const toggle = (label: string): void =>
    setActive((a) => (a.includes(label) ? a.filter((x) => x !== label) : [...a, label]))

  return (
    <main className="cd-page">
      <h1 className="cd-page__title">Results</h1>
      {view.text && <p className="cd-page__text">{view.text}</p>}
      <div className="cd-page__tools">
        <SegmentedControl
          label="Show as"
          value={layout}
          options={[
            { value: 'grid', label: 'Cards' },
            { value: 'table', label: 'Table' }
          ]}
          onChange={onLayout}
        />
        <Select label="Sort" value={sort} options={SORTS} onChange={setSort} />
      </div>
      {chips.length > 0 && (
        <div className="cd-page__chips" role="group" aria-label="Filters">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className="cd-chip"
              aria-pressed={active.includes(c.label)}
              onClick={() => toggle(c.label)}
            >
              {active.includes(c.label) && <icons.check aria-hidden="true" />}
              {c.label}
            </button>
          ))}
        </div>
      )}
      <p className="cd-page__count" role="status">
        {cards.length === view.cards.length
          ? `${cards.length} result${cards.length === 1 ? '' : 's'}`
          : `${cards.length} of ${view.cards.length} results`}
        {message ? `. ${message}` : ''}
      </p>
      {layout === 'grid' ? (
        <ul role="list" className="cd-grid">
          {cards.map((card, i) => (
            <li key={card.id} role="listitem">
              <CardItem
                card={card}
                sources={view.sources}
                now={now}
                level={2}
                position={{ index: i + 1, total: cards.length }}
                onAction={(kind) => onAction(kind, card.id)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="cd-table-wrap" tabIndex={0} role="region" aria-label="Results table">
          <table className="cd-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Price</th>
                <th scope="col">Rating</th>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
                <th scope="col">Source</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => {
                const src = mainSource(card, view.sources)
                const open = card.actions.some((a) => a.kind === 'open')
                return (
                  <tr key={card.id}>
                    <th scope="row">
                      {card.title}
                      {card.subtitle && <span className="cd-table__sub">{card.subtitle}</span>}
                    </th>
                    <td>{card.price ? formatPrice(card.price) : ''}</td>
                    <td>{card.rating ? formatRating(card.rating) : ''}</td>
                    {columns.map((c) => (
                      <td key={c}>{factValue(card, c)}</td>
                    ))}
                    <td>{src ? sourceLine(src, now) : ''}</td>
                    <td>
                      {open && (
                        <button
                          type="button"
                          className="cd-card__btn"
                          onClick={() => onAction('open', card.id)}
                        >
                          Open<span className="visually-hidden"> {card.title}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

function TitleBar(): JSX.Element {
  return (
    <header className="panel-titlebar">
      <span className="panel-titlebar__title">Lumen results</span>
      <span className="panel-titlebar__controls">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => window.lumen.send('settings:window-minimize')}
        >
          <icons.minus />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => window.lumen.send('settings:window-maximize')}
        >
          <icons.square />
        </button>
        <button
          type="button"
          aria-label="Close"
          className="is-close"
          onClick={() => window.lumen.send('settings:window-close')}
        >
          <icons.close />
        </button>
      </span>
    </header>
  )
}

/** The panel page: loads the card set; the layout lives in the route. */
export function AnswerPage({ id, table }: { id: string; table?: boolean }): JSX.Element {
  const { view, missing } = useCardsView(id)
  const [message, setMessage] = useState('')
  const layout: AnswerLayout = table ? 'table' : 'grid'
  return (
    <div className="panel">
      <TitleBar />
      <div className="panel-body cd-page-body">
        {view ? (
          <AnswerPageView
            view={view}
            layout={layout}
            onLayout={(l) => (location.hash = `#/answer/${id}${l === 'table' ? '/table' : ''}`)}
            message={message}
            onAction={(action, cardId) => {
              void runCardAction({ id, cardId, action }).then((r) => setMessage(r.message ?? ''))
            }}
          />
        ) : (
          <main className="cd-page">
            <p role="status">
              {missing ? 'These results are gone. Ask Lumen again to see them.' : 'Loading…'}
            </p>
          </main>
        )}
      </div>
    </div>
  )
}
