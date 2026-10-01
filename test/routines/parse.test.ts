import { describe, expect, it } from 'vitest'
import {
  parseAutomationUtterance,
  parseTriggerText,
  type ParseOpts
} from '../../src/main/routines/parse'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()

// Thursday 2026-10-01 08:00 local.
const NOW = at(2026, 10, 1, 8, 0)
const FOLDERS: Record<string, string> = {
  downloads: 'C:\\Users\\me\\Downloads',
  documents: 'C:\\Users\\me\\Documents'
}
const opts: ParseOpts = {
  now: NOW,
  resolveFolder: (name) => FOLDERS[name.replace(/^(?:my|the) /, '').replace(/ folder$/, '')] ?? null
}
const parse = (s: string): ReturnType<typeof parseAutomationUtterance> =>
  parseAutomationUtterance(s, opts)

describe('time triggers', () => {
  it('daily and every (the routine grammar)', () => {
    expect(parse('every weekday at 9 summarize my inbox')).toEqual({
      ok: true,
      trigger: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
      action: { kind: 'task', prompt: 'summarize my inbox' },
      usedDefaultTime: false
    })
    expect(parse('every 30 minutes check the price of the lamp')).toMatchObject({
      trigger: { kind: 'every', minutes: 30 }
    })
  })

  it('every hour between 9 and 5', () => {
    expect(parse('every hour between 9 and 5 check the build status')).toMatchObject({
      ok: true,
      trigger: { kind: 'every', minutes: 60, from: '09:00', to: '17:00' },
      action: { kind: 'task', prompt: 'check the build status' }
    })
    expect(parse('every 30 minutes from 8:30 to 12 on weekdays check the queue')).toMatchObject({
      trigger: { kind: 'every', minutes: 30, from: '08:30', to: '12:00', days: [1, 2, 3, 4, 5] }
    })
  })

  it('every month on the 1st', () => {
    expect(parse('every month on the 1st summarize my bank statement')).toMatchObject({
      ok: true,
      trigger: { kind: 'monthly', day: 1, at: '09:00' },
      action: { kind: 'task', prompt: 'summarize my bank statement' },
      usedDefaultTime: true
    })
    expect(parse('on the 15th of every month at 6 pm pay the rent reminder list')).toMatchObject({
      trigger: { kind: 'monthly', day: 15, at: '18:00' }
    })
  })

  it('one-offs: tomorrow at 8, in 20 minutes, at 5 pm, on friday', () => {
    expect(parse('tomorrow at 8 check the train times')).toMatchObject({
      trigger: { kind: 'once', at: at(2026, 10, 2, 8) },
      action: { kind: 'task', prompt: 'check the train times' }
    })
    expect(parse('in 20 minutes remind me to stretch')).toEqual({
      ok: true,
      trigger: { kind: 'once', at: NOW + 20 * 60_000 },
      action: { kind: 'remind', say: 'Remember to stretch.' },
      usedDefaultTime: false
    })
    expect(parse('in an hour and a half check the oven timer page')).toMatchObject({
      trigger: { kind: 'once', at: NOW + 90 * 60_000 }
    })
    expect(parse('at 5 pm summarize the news')).toMatchObject({
      trigger: { kind: 'once', at: at(2026, 10, 1, 17) }
    })
    // 07:00 has passed today: tomorrow.
    expect(parse('at 7 am check the weather')).toMatchObject({
      trigger: { kind: 'once', at: at(2026, 10, 2, 7) }
    })
    expect(parse('on friday at 10 back up my notes')).toMatchObject({
      trigger: { kind: 'once', at: at(2026, 10, 2, 10) }
    })
    expect(parse('tomorrow morning summarize my calendar')).toMatchObject({
      trigger: { kind: 'once', at: at(2026, 10, 2, 9) },
      usedDefaultTime: true
    })
  })

  it('"remind me" with the time before or after the reminder', () => {
    expect(parse('remind me in 20 minutes to stretch')).toMatchObject({
      trigger: { kind: 'once', at: NOW + 20 * 60_000 },
      action: { kind: 'remind', say: 'Remember to stretch.' }
    })
    expect(parse('remind me to call Mom tomorrow at 6 pm')).toMatchObject({
      trigger: { kind: 'once', at: at(2026, 10, 2, 18) },
      action: { kind: 'remind', say: 'Remember to call Mom.' }
    })
    expect(parse('remind me every weekday at 9 to take my pills')).toMatchObject({
      trigger: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
      action: { kind: 'remind', say: 'Remember to take my pills.' }
    })
  })

  it('refuses too often or a time in the past, with a reason', () => {
    expect(parse('every 5 minutes check the lamp price')).toEqual({
      ok: false,
      reason: expect.stringMatching(/15 minutes/)
    })
    expect(parse('today at 7 check the weather')).toEqual({
      ok: false,
      reason: expect.stringMatching(/passed/)
    })
  })
})

describe('event triggers', () => {
  it('apps open and close', () => {
    expect(parse('when I open Excel remind me to save a copy')).toEqual({
      ok: true,
      trigger: { kind: 'app', app: 'Excel', on: 'open' },
      action: { kind: 'remind', say: 'Remember to save a copy.' },
      usedDefaultTime: false
    })
    expect(parse('when I close Blender, back up the project folder')).toMatchObject({
      trigger: { kind: 'app', app: 'Blender', on: 'close' },
      action: { kind: 'task', prompt: 'back up the project folder' }
    })
    expect(parse('when Outlook opens, summarize my unread mail')).toMatchObject({
      trigger: { kind: 'app', app: 'Outlook', on: 'open' }
    })
  })

  it('files in a folder', () => {
    expect(parse('When a PDF lands in Downloads, rename it by its title')).toEqual({
      ok: true,
      trigger: { kind: 'file', folder: FOLDERS.downloads, on: 'added', pattern: '*.pdf' },
      action: { kind: 'task', prompt: 'rename it by its title' },
      usedDefaultTime: false
    })
    expect(parse('when a new file appears in my documents folder, tell me its name')).toMatchObject(
      {
        trigger: { kind: 'file', folder: FOLDERS.documents, on: 'added' },
        action: { kind: 'remind' }
      }
    )
    expect(parse('when a file in Documents changes, summarize what changed')).toMatchObject({
      trigger: { kind: 'file', folder: FOLDERS.documents, on: 'changed' }
    })
    expect(parse('when a pdf lands in my secret stash, read it')).toEqual({
      ok: false,
      reason: expect.stringMatching(/folder/)
    })
  })

  it('idle, back, online, startup', () => {
    expect(parse("when I'm idle for 15 minutes, check for new invoices")).toMatchObject({
      trigger: { kind: 'idle', minutes: 15, on: 'idle' }
    })
    expect(parse("when I'm back, summarize what happened")).toMatchObject({
      trigger: { kind: 'idle', minutes: 10, on: 'back' }
    })
    expect(parse('when the internet comes back, retry the upload check')).toMatchObject({
      trigger: { kind: 'online' }
    })
    expect(parse("when I'm back online, check my mail")).toMatchObject({
      trigger: { kind: 'online' }
    })
    expect(parse('when I log in, summarize my calendar')).toMatchObject({
      trigger: { kind: 'startup' }
    })
    expect(parse('at startup run the skill daily standup')).toMatchObject({
      trigger: { kind: 'startup' },
      action: { kind: 'skill', skill: 'daily standup' }
    })
  })

  it('create an automation … with the trigger at the end', () => {
    expect(parse('Create an automation to back up my notes when I log in')).toMatchObject({
      ok: true,
      trigger: { kind: 'startup' },
      action: { kind: 'task', prompt: 'back up my notes' }
    })
    expect(parse('create an automation')).toMatchObject({ ok: false })
  })

  it('ordinary sentences are not automations', () => {
    for (const s of [
      'every day is a gift',
      'when I open Excel, how do I freeze panes',
      'when I open Excel it crashes',
      'tomorrow at 8 I have a meeting',
      'in 20 minutes the pizza is done',
      'when a pdf lands in downloads, what happens',
      'what is the weather',
      'open Excel'
    ])
      expect(parse(s), s).toBeNull()
  })
})

describe('parseTriggerText (Settings "When")', () => {
  it('reads a trigger alone', () => {
    expect(parseTriggerText('every weekday at 9', opts)).toEqual({
      ok: true,
      trigger: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] }
    })
    expect(parseTriggerText('when I open Excel', opts)).toEqual({
      ok: true,
      trigger: { kind: 'app', app: 'Excel', on: 'open' }
    })
    expect(parseTriggerText('every hour between 9 and 17', opts)).toMatchObject({
      ok: true,
      trigger: { from: '09:00', to: '17:00' }
    })
    expect(parseTriggerText('every weekday at 9 do stuff', opts)).toMatchObject({ ok: false })
    expect(parseTriggerText('banana', opts)).toMatchObject({ ok: false })
  })
})
