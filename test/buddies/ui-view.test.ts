// Settings → Buddies and the Home strip (08 T53): avatar, state and run lines, wider
// permissions, month cost, routes and the draft / changed fields sent to main.
import { describe, expect, it } from 'vitest'
import type { BuddyPermissions } from '@shared/buddies'
import type { BuddyEditable, BuddyRow } from '@shared/buddy-views'
import type { UsageReport } from '@shared/usage'
import {
  avatarText,
  buddyFromHash,
  changedFields,
  draftToSave,
  editableOf,
  formProblems,
  inkOn,
  lookFromText,
  monthLine,
  monthSpend,
  nextRunLine,
  parseList,
  permissionRows,
  runLine,
  stateLine,
  whenText
} from '../../src/renderer/src/panel/settings/sections/buddies-view'
import { filterSections } from '../../src/renderer/src/panel/settings/meta'

const perms = (p: Partial<BuddyPermissions> = {}): BuddyPermissions => ({
  tools: [],
  apps: [],
  input: false,
  network: [],
  files: { read: [], write: [] },
  connectors: [],
  profile: false,
  risky: false,
  screen: false,
  ...p
})

const row = (p: Partial<BuddyRow> = {}): BuddyRow => ({
  id: 'inbox-buddy',
  name: 'Inbox Buddy',
  look: { color: '#5b8def', initial: 'I' },
  description: 'Sums up new mail',
  model: 'fast',
  report: 'notify',
  trust: 'mine',
  enabled: true,
  scheduleIds: [],
  running: false,
  onScreen: false,
  ...p
})

const form = (p: Partial<BuddyEditable> = {}): BuddyEditable => ({
  name: 'Inbox Buddy',
  look: { color: '#5b8def', initial: 'I' },
  instructions: 'Sum up new mail.\nFlag the boss.',
  permissions: perms(),
  model: 'fast',
  report: 'notify',
  budget: { perRunUsd: 0.25 },
  skills: [],
  subagents: false,
  ...p
})

// 2026-10-02 (a Friday) 10:00 local.
const NOW = new Date(2026, 9, 2, 10, 0).getTime()

describe('buddy look', () => {
  it('shows its emoji, else its letter, else the first letter of its name', () => {
    expect(avatarText({ color: '#000000', emoji: '📬' })).toBe('📬')
    expect(avatarText({ color: '#000000', initial: 'P' })).toBe('P')
    expect(avatarText({ color: '#000000' }, '  price')).toBe('P')
  })

  it('reads one letter as an initial and a symbol as an emoji', () => {
    expect(lookFromText('d', '#4fb286')).toEqual({ color: '#4fb286', initial: 'D' })
    expect(lookFromText('📬', '#4fb286')).toEqual({ color: '#4fb286', emoji: '📬' })
    expect(lookFromText('<b>', '#4fb286', 'Mail')).toEqual({ color: '#4fb286', initial: 'M' })
  })

  it('picks readable ink on the avatar colour', () => {
    expect(inkOn('#000000')).toBe('#fff')
    expect(inkOn('#ffffff')).toBe('#000')
    expect(inkOn('#e3a33b')).toBe('#000')
    expect(inkOn('not a colour')).toBe('#fff')
  })
})

describe('buddy lines', () => {
  it('says when in local words', () => {
    expect(whenText(new Date(2026, 9, 2, 8, 5).getTime(), NOW)).toBe('today at 08:05')
    expect(whenText(new Date(2026, 9, 3, 8, 0).getTime(), NOW)).toBe('tomorrow at 08:00')
    expect(whenText(new Date(2026, 9, 6, 8, 0).getTime(), NOW)).toBe('Tue 6 Oct at 08:00')
    expect(nextRunLine(undefined, NOW)).toBe('')
    expect(nextRunLine(new Date(2026, 9, 3, 8, 0).getTime(), NOW)).toBe('Next: tomorrow at 08:00')
  })

  it('shows working, off, the last result or no runs', () => {
    expect(stateLine(row({ onScreen: true, running: true }))).toBe('Working on screen')
    expect(stateLine(row({ running: true }))).toBe('Working…')
    expect(stateLine(row({ enabled: false }))).toBe('Off')
    expect(stateLine(row())).toBe('No runs yet')
    const lastRun = {
      taskId: 'bg_1',
      title: 'Inbox Buddy',
      phase: 'done',
      startedAt: NOW,
      costUsd: 0.02,
      summary: '3 new mails,\n one from your boss.'
    }
    expect(stateLine(row({ lastRun }))).toBe('3 new mails, one from your boss.')
    expect(stateLine(row({ lastRun: { ...lastRun, phase: 'failed' } }))).toBe('Failed')
    expect(runLine(lastRun, NOW)).toBe('Done · today at 10:00 · $0.02')
    expect(runLine({ ...lastRun, costUsd: 0.001 }, NOW)).toBe('Done · today at 10:00 · < $0.01')
  })

  it('takes this month from the usage report and shows the limits', () => {
    const report = {
      tables: {
        buddy: [
          {
            key: 'inbox-buddy',
            name: 'Inbox Buddy',
            sums: { usd: 0.42, in: 10_000, out: 2_300 }
          }
        ]
      }
    } as unknown as UsageReport
    const m = monthSpend(report, 'inbox-buddy')
    expect(m).toEqual({ usd: 0.42, tokens: 12_300 })
    expect(monthSpend(report, 'price-buddy')).toEqual({ usd: 0, tokens: 0 })
    expect(monthSpend(null, 'x')).toEqual({ usd: 0, tokens: 0 })
    expect(monthLine(m, { perRunUsd: 0.25 })).toBe('$0.42 this month · 12,300 tokens')
    expect(monthLine(m, { perRunUsd: 0.25, perMonthUsd: 5, perMonthTokens: 100_000 })).toBe(
      '$0.42 of $5.00 this month · 12,300 of 100,000 tokens'
    )
  })
})

describe('buddy permissions', () => {
  it('marks what goes past reading for a new draft', () => {
    const rows = permissionRows(
      perms({
        tools: ['fetch_url', 'move_file'],
        network: ['https://example.org'],
        files: { read: ['C:\\Users\\me\\Downloads'], write: [] },
        risky: true
      })
    )
    expect(rows.map((r) => [r.key, r.wider])).toEqual([
      ['tools', true],
      ['network', true],
      ['read', false],
      ['risky', false]
    ])
    expect(rows[0].text).toBe('Tools: Read web pages, Move files')
    expect(permissionRows(perms())).toEqual([
      { key: 'none', text: 'Only reads what it is given and answers', wider: false }
    ])
  })

  it('marks only what grew against the saved buddy', () => {
    const before = perms({ tools: ['fetch_url'], network: ['https://a.example'], input: true })
    const after = perms({
      tools: ['fetch_url'],
      network: ['https://a.example', 'https://b.example'],
      input: true,
      apps: ['outlook'],
      profile: true
    })
    const wider = permissionRows(after, before)
      .filter((r) => r.wider)
      .map((r) => r.key)
    expect(wider).toEqual(['network', 'input', 'profile'])
    expect(permissionRows(before, before).some((r) => r.wider)).toBe(false)
  })
})

describe('buddy forms', () => {
  it('parses lists and routes', () => {
    expect(parseList(' https://a.example\n\nhttps://b.example, https://a.example ')).toEqual([
      'https://a.example',
      'https://b.example'
    ])
    expect(buddyFromHash('#/settings/buddies/inbox-buddy')).toBe('inbox-buddy')
    expect(buddyFromHash('#/settings/buddies/_new')).toBe('_new')
    expect(buddyFromHash('#/settings/buddies')).toBeNull()
    expect(buddyFromHash('#/settings/buddies/../x')).toBeNull()
    expect(buddyFromHash('#/settings/voice/inbox-buddy')).toBeNull()
  })

  it('checks the form and sends only changed fields', () => {
    expect(formProblems(form())).toEqual([])
    expect(formProblems(form({ name: ' ', instructions: '' }))).toEqual([
      'Give it a name.',
      'Say what it should do.'
    ])
    const saved = form()
    const edited = editableOf(saved)
    edited.permissions.files.read.push('C:\\Data')
    expect(saved.permissions.files.read).toEqual([])
    expect(changedFields(edited, saved)).toEqual({ permissions: edited.permissions })
    expect(changedFields(saved, form())).toEqual({})
  })

  it('builds the draft to save with the schedule phrase only when one is given', () => {
    const d = draftToSave(form({ name: ' Inbox Buddy ' }), ' every weekday at 8 ')
    expect(d.name).toBe('Inbox Buddy')
    expect(d.description).toBe('Sum up new mail.')
    expect(d.schedule?.text).toBe('every weekday at 8')
    expect(draftToSave(form(), '  ').schedule).toBeUndefined()
  })

  it('finds the section by buddy, helper or assistant', () => {
    for (const q of ['buddy', 'helper', 'assistant'])
      expect(filterSections(q).map((s) => s.id)).toContain('buddies')
  })
})
