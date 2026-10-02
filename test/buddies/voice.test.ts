// Calling buddies by voice (08 T52): the grammar, name matching, "which one?" and the replies.
import { describe, expect, it, vi } from 'vitest'
import type { Buddy, BuddySummary } from '@shared/buddies'
import {
  agoText,
  BuddyVoice,
  lastText,
  parseBuddyCommand,
  resolveWhich,
  statusText,
  whenText,
  type BuddyVoiceDeps
} from '../../src/main/buddies/voice'

const refs = [
  { id: 'inbox-buddy', name: 'Inbox Buddy' },
  { id: 'price-buddy', name: 'Price Buddy' },
  { id: 'downloads-buddy', name: 'Downloads Buddy' },
  { id: 'research', name: 'Research' }
]
const p = (t: string): ReturnType<typeof parseBuddyCommand> => parseBuddyCommand(t, refs)

describe('calling a buddy', () => {
  it('runs it with the rest of the words', () => {
    expect(p("Inbox Buddy, what's new?")).toEqual({
      kind: 'call',
      id: 'inbox-buddy',
      utterance: "what's new?"
    })
    expect(p('hey Price Buddy add the Sony ones')).toEqual({
      kind: 'call',
      id: 'price-buddy',
      utterance: 'add the Sony ones'
    })
    expect(p('ask Price Buddy to add the Sony ones')).toMatchObject({
      id: 'price-buddy',
      utterance: 'add the Sony ones'
    })
    expect(p('have the Downloads Buddy tidy up now')).toMatchObject({
      kind: 'call',
      id: 'downloads-buddy',
      utterance: 'tidy up now'
    })
    expect(p('run Inbox Buddy now')).toEqual({ kind: 'call', id: 'inbox-buddy', utterance: '' })
    expect(p('Inbox Buddy')).toEqual({ kind: 'call', id: 'inbox-buddy', utterance: '' })
  })

  it('matches without "buddy", any case, and one misheard letter', () => {
    expect(p("inbox, what's new")).toMatchObject({ id: 'inbox-buddy' })
    expect(p('INBOX BODY, anything new?')).toMatchObject({ id: 'inbox-buddy' })
    expect(p('Prise Buddy, check the prices')).toMatchObject({ id: 'price-buddy' })
    expect(p("Inbox Buddy's turn: check mail")).toMatchObject({ id: 'inbox-buddy' })
  })

  it('needs a comma or "hey" for a short name, so plain requests stay plain', () => {
    expect(p('research the best laptops')).toBeNull()
    expect(p('inbox zero tips')).toBeNull()
    expect(p('Research, the best laptops please')).toMatchObject({ id: 'research' })
    expect(p('hey research find laptops')).toMatchObject({ id: 'research' })
    expect(p('ask research to find laptops')).toMatchObject({ id: 'research' })
    expect(p('run research')).toBeNull()
    expect(p('have a look at this')).toBeNull()
    expect(p('what is the price of gold')).toBeNull()
    expect(p('stop the music')).toBeNull()
  })

  it('asks which when two names fit equally', () => {
    const two = [
      { id: 'price-buddy', name: 'Price Buddy' },
      { id: 'prize-buddy', name: 'Prize Buddy' }
    ]
    const r = parseBuddyCommand('Prise Buddy, go', two)
    expect(r).toMatchObject({ kind: 'ambiguous', ids: ['price-buddy', 'prize-buddy'] })
    // An exact name wins over a close one.
    expect(parseBuddyCommand('Price Buddy, go', two)).toMatchObject({ id: 'price-buddy' })
    expect(resolveWhich('the prize one', two)).toBe('prize-buddy')
    expect(resolveWhich('the second', two)).toBe('prize-buddy')
    expect(resolveWhich('never mind', two)).toBeNull()
  })

  it('says when there is no such buddy', () => {
    expect(p('stop Foo Buddy')).toEqual({ kind: 'unknown', name: 'foo buddy' })
    expect(p('ask the Weather Buddy to check')).toEqual({ kind: 'unknown', name: 'weather buddy' })
    expect(p('Weather Buddy, anything?')).toEqual({ kind: 'unknown', name: 'weather buddy' })
    expect(p('hey buddy, how are you')).toBeNull()
    expect(p('have a nice day buddy')).toBeNull()
  })
})

describe('controls', () => {
  it('stop, pause, turn off and on', () => {
    expect(p('stop Price Buddy')).toEqual({ kind: 'stop', id: 'price-buddy' })
    expect(p('cancel the Price Buddy now')).toEqual({ kind: 'stop', id: 'price-buddy' })
    expect(p('pause Price Buddy')).toEqual({ kind: 'enable', id: 'price-buddy', on: false })
    expect(p('turn off Inbox Buddy')).toEqual({ kind: 'enable', id: 'inbox-buddy', on: false })
    expect(p('turn Inbox Buddy off')).toEqual({ kind: 'enable', id: 'inbox-buddy', on: false })
    expect(p('turn Inbox Buddy back on')).toEqual({ kind: 'enable', id: 'inbox-buddy', on: true })
    expect(p('resume Inbox Buddy')).toEqual({ kind: 'enable', id: 'inbox-buddy', on: true })
    // A short name after a verb is too loose.
    expect(p('pause research')).toBeNull()
    expect(p('stop Price Buddy from buying')).toBeNull()
  })

  it('all buddies, status and last result', () => {
    expect(p('pause all buddies')).toEqual({ kind: 'pause-all' })
    expect(p('turn my buddies off')).toEqual({ kind: 'pause-all' })
    expect(p('resume buddies')).toEqual({ kind: 'resume-all' })
    expect(p('turn the buddies back on')).toEqual({ kind: 'resume-all' })
    expect(p('stop all buddies')).toEqual({ kind: 'stop-all' })
    expect(p('what are my buddies doing?')).toEqual({ kind: 'status' })
    expect(p("what're my buddies up to")).toEqual({ kind: 'status' })
    expect(p('what did Inbox Buddy find?')).toEqual({ kind: 'last', id: 'inbox-buddy' })
    expect(p('what has the Price Buddy found')).toEqual({ kind: 'last', id: 'price-buddy' })
  })
})

describe('spoken lines', () => {
  const now = new Date(2026, 9, 2, 10, 0).getTime()
  it('ago and when', () => {
    expect(agoText(now - 30_000, now)).toBe('just now')
    expect(agoText(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(agoText(now - 3 * 3600_000, now)).toBe('3 hours ago')
    expect(agoText(now - 30 * 3600_000, now)).toBe('yesterday')
    expect(whenText(new Date(2026, 9, 2, 17, 5).getTime(), now)).toBe('at 17:05')
    expect(whenText(new Date(2026, 9, 3, 8, 0).getTime(), now)).toBe('tomorrow at 08:00')
    expect(whenText(new Date(2026, 9, 5, 8, 0).getTime(), now)).toBe('on Monday at 08:00')
  })

  const row = (p: Partial<BuddySummary>): BuddySummary => ({
    id: 'inbox-buddy',
    name: 'Inbox Buddy',
    look: { color: '#5b8def', initial: 'I' },
    description: '',
    model: 'fast',
    report: 'notify',
    trust: 'mine',
    enabled: true,
    scheduleIds: [],
    running: false,
    ...p
  })

  it('status: running, off, last run and next run', () => {
    const s = statusText(
      [
        row({ running: true }),
        row({ id: 'p', name: 'Price Buddy', enabled: false }),
        row({
          id: 'd',
          name: 'Downloads Buddy',
          lastRun: {
            taskId: 'bg_1',
            title: 't',
            phase: 'done',
            startedAt: now - 7200_000,
            endedAt: now - 7200_000,
            summary: 'Renamed 3 PDFs. Two more were skipped.',
            costUsd: 0
          }
        })
      ],
      (x) => (x.id === 'd' ? new Date(2026, 9, 3, 8, 0).getTime() : undefined),
      false,
      now
    )
    expect(s.spoken).toBe(
      'Inbox Buddy is working right now. Price Buddy is turned off. Downloads Buddy last ran 2 hours ago: Renamed 3 PDFs. Next run tomorrow at 08:00.'
    )
    expect(statusText([], () => undefined, false, now).text).toMatch(/no buddies yet/)
    expect(statusText([row({})], () => now + 1000, true, now).spoken).toMatch(
      /^All buddies are paused.*hasn’t run yet\.$/
    )
  })

  it('last result', () => {
    expect(lastText('Inbox Buddy', false, undefined, now)).toBe('Inbox Buddy hasn’t run yet.')
    const last = {
      taskId: 'bg_1',
      title: 't',
      phase: 'done',
      startedAt: now - 600_000,
      endedAt: now - 300_000,
      summary: '2 new mails from your boss.',
      costUsd: 0
    }
    expect(lastText('Inbox Buddy', false, last, now)).toBe(
      'Inbox Buddy, 5 minutes ago: 2 new mails from your boss.'
    )
    expect(lastText('Inbox Buddy', true, { ...last, endedAt: undefined }, now)).toBe(
      'Inbox Buddy is still working on it.'
    )
  })
})

describe('BuddyVoice', () => {
  const buddy = (id: string, name: string): Buddy =>
    ({ id, name, enabled: true }) as unknown as Buddy
  function setup(list: Buddy[]): { v: BuddyVoice; deps: BuddyVoiceDeps } {
    let paused = false
    const deps: BuddyVoiceDeps = {
      list: () => list,
      summaries: () => [],
      call: vi.fn(async (b: Buddy, u: string) => ({
        mode: 'answer' as const,
        text: `${b.name} <${u}>`
      })),
      stop: vi.fn(() => 1),
      stopAll: vi.fn(() => 2),
      setEnabled: vi.fn(() => true),
      pausedAll: () => paused,
      setPausedAll: vi.fn((v: boolean) => {
        paused = v
      }),
      nextRunAt: () => undefined,
      lastRun: () => undefined,
      now: () => 1000
    }
    return { v: new BuddyVoice(deps), deps }
  }

  it('calls, stops and pauses', async () => {
    const { v, deps } = setup([buddy('inbox-buddy', 'Inbox Buddy')])
    expect(await v.turn('Inbox Buddy, anything new?')).toMatchObject({
      text: 'Inbox Buddy <anything new?>'
    })
    expect((await v.turn('stop Inbox Buddy'))?.text).toBe('Stopped Inbox Buddy.')
    expect(deps.stop).toHaveBeenCalledWith('inbox-buddy')
    expect((await v.turn('pause all buddies'))?.text).toMatch(/^Paused all buddies/)
    expect(deps.setPausedAll).toHaveBeenCalledWith(true)
    expect((await v.turn('turn off Inbox Buddy'))?.text).toMatch(/Inbox Buddy is off/)
    expect(deps.setEnabled).toHaveBeenCalledWith('inbox-buddy', false)
    expect(await v.turn('open notepad')).toBeNull()
  })

  it('asks which, then runs the one named next', async () => {
    const { v, deps } = setup([
      buddy('price-buddy', 'Price Buddy'),
      buddy('prize-buddy', 'Prize Buddy')
    ])
    expect((await v.turn('Prise Buddy, check headphones'))?.text).toBe(
      'Which buddy: Price Buddy or Prize Buddy?'
    )
    expect((await v.turn('the prize one'))?.text).toBe('Prize Buddy <check headphones>')
    expect(deps.call).toHaveBeenCalledTimes(1)
  })

  it('tells about a name it does not know', async () => {
    const { v } = setup([buddy('inbox-buddy', 'Inbox Buddy')])
    expect((await v.turn('stop Foo Buddy'))?.text).toBe(
      'I don’t have a buddy called Foo Buddy. Your buddies: Inbox Buddy.'
    )
  })
})
