// The bar's card strip mounts only the cards around the visible window; the rest are empty
// placeholders of the same width, so the track's transform and the window maths stay as they are.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CardStripView, STRIP_VISIBLE } from '../../src/renderer/src/cards/CardStrip'
import { windowStart } from '../../src/renderer/src/cards/view'
import { CHECKED, hotelView } from './fixture'

const now = CHECKED + 2 * 3_600_000
const noop = (): void => {}

function twelve(): ReturnType<typeof hotelView> {
  const v = hotelView()
  const base = v.cards[0]
  const cards = Array.from({ length: 12 }, (_, i) => ({
    ...base,
    id: `h${i + 1}`,
    title: `Hotel ${i + 1}`,
    image: { src: 'data:image/jpeg;base64,AAAA', alt: `Hotel ${i + 1}` }
  }))
  return { ...v, cards }
}

describe('card strip window', () => {
  it('mounts the visible cards and one after them at the start', () => {
    const html = renderToStaticMarkup(
      createElement(CardStripView, { view: twelve(), now, onAction: noop })
    )
    expect(html.match(/<img/g)).toHaveLength(4)
    expect(html.match(/data-card=/g)).toHaveLength(4)
    // Every position keeps its list item, so the track still has 12 columns to slide over.
    expect(html.match(/class="cd-strip__item/g)).toHaveLength(12)
    expect(html).toContain('aria-label="12 results"')
    expect(html).toContain('decoding="async"')
  })

  it('moving the window brings the next cards in and keeps one on each side', () => {
    const drawn = (initialStart: number): string[] =>
      [
        ...renderToStaticMarkup(
          createElement(CardStripView, { view: twelve(), now, initialStart, onAction: noop })
        ).matchAll(/data-card="(h\d+)"/g)
      ].map((m) => m[1])
    expect(drawn(0)).toEqual(['h1', 'h2', 'h3', 'h4'])
    // Arrow Right from the third card moves the window by one; the next card is already there.
    const next = windowStart(0, 3, 12, STRIP_VISIBLE)
    expect(drawn(next)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
    expect(drawn(5)).toEqual(['h5', 'h6', 'h7', 'h8', 'h9'])
    expect(drawn(windowStart(99, 99, 12))).toEqual(['h9', 'h10', 'h11', 'h12'])
  })

  it('places the drawn cards at their own positions in the track', () => {
    const html = renderToStaticMarkup(
      createElement(CardStripView, { view: twelve(), now, initialStart: 5, onAction: noop })
    )
    expect(html).toContain('translateX(calc(-5 * (100% + var(--cd-gap)) / 3))')
    const items = html.split('class="cd-strip__item').slice(1)
    expect(items.map((it) => /data-card="(h\d+)"/.exec(it)?.[1] ?? '-')).toEqual([
      '-',
      '-',
      '-',
      '-',
      'h5',
      'h6',
      'h7',
      'h8',
      'h9',
      '-',
      '-',
      '-'
    ])
    expect(html).toContain('6–8 of 12')
  })
})
