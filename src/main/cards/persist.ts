// Card sets on disk (05 T42): `~/.ai-overlay/cards/<id>.json`, the newest 30, so a background
// task's "View results" still opens after a restart. Pictures are not stored (only their remote
// refs; they are fetched again, usually from the card-images cache). Nothing is written or read
// in private mode. A file is validated like fresh cards before it is used.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { CARDS_ID_RE } from '@shared/cards'
import { configPath, loadConfig } from '../config'
import { imageRefSchema, summarySchema, validateCards } from './schema'
import type { CardsDisk, CardsSnapshot } from './store'

export const KEEP_FILES = 30
const MAX_FILE_BYTES = 512 * 1024

function defaultDir(): string | null {
  return loadConfig().memory.privateMode ? null : join(dirname(configPath()), 'cards')
}

/** The cards with each image ref or summary that does not validate left out. */
function withoutBadExtras(raw: unknown): unknown {
  const o = raw as { cards?: unknown }
  if (!raw || typeof raw !== 'object' || !Array.isArray(o.cards)) return raw
  const cards = o.cards.map((c: unknown) => {
    if (!c || typeof c !== 'object') return c
    const card = { ...(c as Record<string, unknown>) }
    if ('image' in card && !imageRefSchema.safeParse(card.image).success) delete card.image
    if ('summary' in card && !summarySchema.safeParse(card.summary).success) delete card.summary
    return card
  })
  return { ...o, cards }
}

/** Parses and validates a saved set; null when anything is off. Pure. */
export function parseSnapshot(raw: string, id: string): CardsSnapshot | null {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (o.v !== 1 || o.id !== id || typeof o.text !== 'string' || o.text.length > 4000) return null
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null
  let check = validateCards(o.cards)
  // A bad picture ref or summary (found after the set was shown) costs only that part.
  if (!check.ok) check = validateCards(withoutBadExtras(o.cards))
  if (!check.ok) return null
  const snap: CardsSnapshot = { id, text: o.text, cards: check.cards, createdAt: o.createdAt }
  if (typeof o.request === 'string' && o.request.length <= 4000) snap.request = o.request
  return snap
}

export class CardsFiles implements CardsDisk {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly dir: () => string | null = defaultDir) {}

  save(snap: CardsSnapshot): void {
    const dir = this.dir()
    if (!dir || !CARDS_ID_RE.test(snap.id)) return
    const body = JSON.stringify({ v: 1, ...snap })
    if (body.length > MAX_FILE_BYTES) return
    this.chain = this.chain.then(() => this.write(dir, snap.id, body)).catch(() => {})
  }

  /** Resolves once queued writes are done (tests). */
  flush(): Promise<void> {
    return this.chain
  }

  private async write(dir: string, id: string, body: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${id}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
    await this.prune(dir)
  }

  /** Keeps the newest 30 files (by modification time). */
  async prune(dir: string): Promise<number> {
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => /^c_[a-z0-9]{4,40}\.json$/.test(n))
    } catch {
      return 0
    }
    if (names.length <= KEEP_FILES) return 0
    const dated = await Promise.all(
      names.map(async (n) => ({
        n,
        t: await stat(join(dir, n)).then(
          (s) => s.mtimeMs,
          () => 0
        )
      }))
    )
    dated.sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1))
    let removed = 0
    for (const { n } of dated.slice(KEEP_FILES)) {
      await unlink(join(dir, n)).then(
        () => removed++,
        () => {}
      )
    }
    return removed
  }

  async load(id: string): Promise<CardsSnapshot | null> {
    const dir = this.dir()
    if (!dir || !CARDS_ID_RE.test(id)) return null
    try {
      const file = join(dir, `${id}.json`)
      if ((await stat(file)).size > MAX_FILE_BYTES) return null
      return parseSnapshot(await readFile(file, 'utf8'), id)
    } catch {
      return null
    }
  }
}
