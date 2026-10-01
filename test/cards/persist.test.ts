// Card sets on disk (05 T42): saved without pictures, newest 30 kept, nothing in private mode,
// tampered files refused, and a set reopens after a "restart" (a fresh store) with its pictures
// fetched again.
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  cardAction,
  installCardsDisk,
  loadCardsView,
  presentCards,
  setCardsPorts,
  store
} from '../../src/main/cards'
import { CardsFiles, KEEP_FILES, parseSnapshot } from '../../src/main/cards/persist'
import { CardsStore, snapshotOf } from '../../src/main/cards/store'
import { hotelCards } from './fixture'

const root = mkdtempSync(join(tmpdir(), 'lumen-cards-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const freshDir = (): string => join(root, `d${++n}`)

afterEach(() => {
  installCardsDisk(null)
  setCardsPorts(null)
})

describe('CardsFiles', () => {
  it('saves a set without image data and reads it back validated', async () => {
    const dir = freshDir()
    const files = new CardsFiles(() => dir)
    const s = new CardsStore(Date.now, files)
    const set = s.add('3 hotels', hotelCards(), { request: 'hotels in Nice' })
    s.setImage(set.id, 'h1', { src: 'data:image/jpeg;base64,AAAA', alt: 'x' })
    await files.flush()
    const raw = readFileSync(join(dir, `${set.id}.json`), 'utf8')
    expect(raw).not.toContain('data:image')
    expect(raw).toContain('https://img.hotels.test/azur.jpg')
    const back = await files.load(set.id)
    expect(back).toEqual(snapshotOf(set))
    expect(back?.request).toBe('hotels in Nice')
  })

  it('refuses bad ids, other ids and tampered cards', async () => {
    const dir = freshDir()
    const files = new CardsFiles(() => dir)
    await expect(files.load('../config')).resolves.toBeNull()
    const set = new CardsStore(Date.now, files).add('x', hotelCards())
    await files.flush()
    const file = join(dir, `${set.id}.json`)
    const good = JSON.parse(readFileSync(file, 'utf8'))
    expect(parseSnapshot(JSON.stringify(good), 'c_other1234')).toBeNull()
    good.cards.cards[0].links[0].url = 'http://127.0.0.1/x'
    writeFileSync(file, JSON.stringify(good))
    await expect(files.load(set.id)).resolves.toBeNull()
    expect(parseSnapshot('{nope', set.id)).toBeNull()
  })

  it('keeps the newest 30', async () => {
    const dir = freshDir()
    const files = new CardsFiles(() => dir)
    const s = new CardsStore(Date.now, files)
    const ids: string[] = []
    for (let i = 0; i < KEEP_FILES + 3; i++) {
      ids.push(s.add(`set ${i}`, hotelCards()).id)
      await files.flush()
      // Distinct, increasing times so "newest" is well defined.
      const t = new Date(Date.UTC(2026, 0, 1, 0, i))
      utimesSync(join(dir, `${ids[i]}.json`), t, t)
    }
    await files.prune(dir)
    const left = readdirSync(dir)
    expect(left).toHaveLength(KEEP_FILES)
    expect(left).not.toContain(`${ids[0]}.json`)
    expect(left).toContain(`${ids[ids.length - 1]}.json`)
  })

  it('private mode: nothing written or read', async () => {
    const files = new CardsFiles(() => null)
    const set = new CardsStore(Date.now, files).add('x', hotelCards())
    await files.flush()
    await expect(files.load(set.id)).resolves.toBeNull()
  })
})

describe('reopening after a restart', () => {
  it('a fresh store loads the set from disk, kept by id only', async () => {
    const dir = freshDir()
    const files = new CardsFiles(() => dir)
    const before = new CardsStore(Date.now, files).add('3 hotels', hotelCards())
    await files.flush()
    const after = new CardsStore(Date.now, files)
    expect(after.get(before.id)).toBeNull()
    const r = await after.load(before.id)
    expect(r?.fromDisk).toBe(true)
    expect(r?.set.cards.cards).toHaveLength(3)
    expect(after.latest()).toBeNull()
    expect(after.view(before.id)?.cards[0].imagePending).toBe(true)
  })

  it('cards:get and a card button work on a saved set; its picture loads again', async () => {
    const dir = freshDir()
    const files = new CardsFiles(() => dir)
    installCardsDisk(files)
    const resolve = vi.fn(async () => 'data:image/jpeg;base64,BBBB')
    const openUrl = vi.fn(async () => true)
    setCardsPorts(
      {
        showAnswer: vi.fn(),
        openUrl,
        saveNote: vi.fn(async () => true),
        openPanel: vi.fn(),
        runQuery: vi.fn(),
        say: vi.fn()
      },
      { resolve }
    )
    const shown = presentCards('3 hotels', hotelCards(), { show: false, conversation: false })
    if (!shown.ok) throw new Error(shown.error)
    await files.flush()
    // Simulate a restart: the in-memory copy is gone.
    const s = store as unknown as { sets: Map<string, unknown> }
    s.sets.delete(shown.id)
    expect(store.get(shown.id)).toBeNull()

    const v = await loadCardsView(shown.id)
    expect(v?.cards).toHaveLength(3)
    await vi.waitFor(() => expect(store.view(shown.id)?.cards[0].image?.src).toContain('BBBB'))

    s.sets.delete(shown.id)
    const r = await cardAction({ id: shown.id, cardId: 'h1', action: 'open' })
    expect(r.ok).toBe(true)
    expect(openUrl).toHaveBeenCalledWith('https://hotels.test/azur')
  })

  it('a set that was never saved stays gone', async () => {
    installCardsDisk(new CardsFiles(() => freshDir()))
    await expect(loadCardsView('c_missing123')).resolves.toBeNull()
  })
})
