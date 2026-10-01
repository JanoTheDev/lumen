// Pictures for research cards (05 T39): a card without an image gets the picture its own page
// names (og:image / twitter:image / a large <img>), else, for places and things, a Wikimedia
// Commons picture with its credit line. Runs after the cards are shown; each found picture is
// fetched like any card image and the views are refreshed through `cards.changed`. Entity
// cards (T42) also get a short Wikipedia summary (and its one-line description as subtitle).
// The set is saved again afterwards so a reopened set keeps what was found.
import type { ImageRef } from '@shared/cards'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { effectiveLanguage } from '../speech/language'
import { wikiSummary, type WikiSummary } from './entity'
import { cardImages, commonsImage, imageFromPage, type CardImages } from './images'
import { store } from './index'

export interface ImageFinder {
  fromPage(pageUrl: string, alt: string, signal: AbortSignal): Promise<ImageRef | null>
  commons(query: string, signal: AbortSignal): Promise<ImageRef | null>
  resolve: CardImages['resolve']
  /** An entity's Wikipedia summary (T42). */
  summary?(title: string, signal: AbortSignal): Promise<WikiSummary | null>
}

const defaultFinder: ImageFinder = {
  fromPage: (url, alt, signal) => imageFromPage(url, alt, undefined, signal),
  commons: (q, signal) => commonsImage(q, undefined, signal),
  resolve: (url) => cardImages.resolve(url),
  summary: (title, signal) =>
    wikiSummary(title, effectiveLanguage(loadConfig().voice.language), undefined, signal)
}

let finder: ImageFinder = defaultFinder

/** Tests: a fake finder; null = the real one. */
export function setImageFinder(f: ImageFinder | null): void {
  finder = f ?? defaultFinder
}

export const FIND_TIMEOUT_MS = 20_000
const PARALLEL = 4

/** Wikipedia summaries for the set's entity cards that have none. */
async function findSummaries(id: string, signal: AbortSignal): Promise<boolean> {
  const set = store.get(id)
  const lookup = finder.summary
  if (!set || !lookup) return false
  const todo = set.cards.cards.filter((c) => c.kind === 'entity' && !c.summary).slice(0, 6)
  let changed = false
  await Promise.all(
    todo.map(async (card) => {
      const found = await lookup(card.title, signal).catch(() => null)
      if (!found) return
      card.summary = found.summary
      if (!card.subtitle && found.description) card.subtitle = found.description
      changed = true
    })
  )
  if (changed) bus.emit({ type: 'cards.changed', id })
  return changed
}

/**
 * Looks up pictures for the cards of set `id` that have none, and summaries for its entity
 * cards. Never throws.
 */
export async function findCardImages(id: string): Promise<void> {
  const set = store.get(id)
  if (!set) return
  const signal = AbortSignal.timeout(FIND_TIMEOUT_MS)
  const summaries = findSummaries(id, signal)
  const found = await findPictures(id, signal)
  const changed = (await summaries) || found
  if (changed) store.persist(id)
}

async function findPictures(id: string, signal: AbortSignal): Promise<boolean> {
  const set = store.get(id)
  if (!set) return false
  const todo = set.cards.cards.filter((c) => !c.image && set.images.get(c.id) === null)
  if (!todo.length) return false
  let changed = false
  for (const c of todo) store.markPending(id, c.id)
  bus.emit({ type: 'cards.changed', id })
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
      if (src && ref) {
        card.image = ref
        changed = true
      }
      const image =
        src && ref
          ? { src, alt: ref.alt, ...(ref.attribution ? { attribution: ref.attribution } : {}) }
          : null
      if (store.setImage(id, card.id, image)) bus.emit({ type: 'cards.changed', id })
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker))
  return changed
}
