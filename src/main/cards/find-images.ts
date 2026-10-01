// Pictures for research cards (05 T39): a card without an image gets the picture its own page
// names (og:image / twitter:image / a large <img>), else, for places and things, a Wikimedia
// Commons picture with its credit line. Runs after the cards are shown; each found picture is
// fetched like any card image and the views are refreshed through `cards.changed`.
import type { ImageRef } from '@shared/cards'
import { bus } from '../bus'
import { cardImages, commonsImage, imageFromPage, type CardImages } from './images'
import { store } from './index'

export interface ImageFinder {
  fromPage(pageUrl: string, alt: string, signal: AbortSignal): Promise<ImageRef | null>
  commons(query: string, signal: AbortSignal): Promise<ImageRef | null>
  resolve: CardImages['resolve']
}

const defaultFinder: ImageFinder = {
  fromPage: (url, alt, signal) => imageFromPage(url, alt, undefined, signal),
  commons: (q, signal) => commonsImage(q, undefined, signal),
  resolve: (url) => cardImages.resolve(url)
}

let finder: ImageFinder = defaultFinder

/** Tests: a fake finder; null = the real one. */
export function setImageFinder(f: ImageFinder | null): void {
  finder = f ?? defaultFinder
}

export const FIND_TIMEOUT_MS = 20_000
const PARALLEL = 4

/** Looks up pictures for the cards of set `id` that have none. Never throws. */
export async function findCardImages(id: string): Promise<void> {
  const set = store.get(id)
  if (!set) return
  const todo = set.cards.cards.filter((c) => !c.image && set.images.get(c.id) === null)
  if (!todo.length) return
  for (const c of todo) store.markPending(id, c.id)
  bus.emit({ type: 'cards.changed', id })
  const signal = AbortSignal.timeout(FIND_TIMEOUT_MS)
  const queue = [...todo]
  const worker = async (): Promise<void> => {
    for (let card = queue.shift(); card; card = queue.shift()) {
      let ref: ImageRef | null = null
      try {
        const page = card.links[0]?.url
        if (page) ref = await finder.fromPage(page, card.title, signal)
        if (!ref && (card.kind === 'place' || card.kind === 'entity'))
          ref = await finder.commons(card.title, signal)
      } catch {
        ref = null
      }
      const src = ref ? await finder.resolve(ref.sourceUrl).catch(() => null) : null
      if (src && ref) card.image = ref
      const image =
        src && ref
          ? { src, alt: ref.alt, ...(ref.attribution ? { attribution: ref.attribution } : {}) }
          : null
      if (store.setImage(id, card.id, image)) bus.emit({ type: 'cards.changed', id })
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker))
}
