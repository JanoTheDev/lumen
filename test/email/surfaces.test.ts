// Which email surface is in front (08 email): the Gmail, new Outlook and classic Outlook packs
// match by process, title and URL; their guide text fits the prompt cap; the email skills load,
// trigger by phrase and keep Send for the user.
import { join, resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  matchSkill,
  setSkillsDir,
  skillContext,
  skillPacks,
  SKILL_TOKEN_CAP
} from '../../src/main/ai/skills'
import { estimateTokens } from '../../src/main/ai/prompts/assemble'
import { loadSkill } from '../../src/main/skills/disclosure'
import { SkillRegistry } from '../../src/main/skills/registry'
import { matchSkillTrigger } from '../../src/main/skills/triggers'

const SKILLS = resolve(__dirname, '../../skills')
const BUILTIN = join(SKILLS, 'builtin')
const EMAIL_SKILLS = [
  'reply-to-this-email',
  'write-an-email',
  'summarize-my-inbox',
  'search-my-mail'
]

beforeAll(() => setSkillsDir(SKILLS))

const packOf = (fg: { process?: string; title?: string; url?: string }): string | null =>
  matchSkill(fg)?.id ?? null

describe('email surface detection', () => {
  it.each([
    ['chrome.exe', 'Inbox (3) - jip@example.com - Gmail - Google Chrome', 'gmail'],
    [
      'msedge.exe',
      'Inbox (3) - jip@example.com - Gmail and 2 more pages - Personal - Microsoft​ Edge',
      'gmail'
    ],
    ['firefox.exe', 'Inbox (3) - jip@example.com - Gmail — Mozilla Firefox', 'gmail'],
    ['olk.exe', 'Mail - Jan Om - Outlook', 'outlook'],
    ['msedge.exe', 'Mail - Jan Om - Outlook - Personal - Microsoft​ Edge', 'outlook'],
    ['OUTLOOK.EXE', 'Inbox - jan@example.com - Outlook', 'outlook-classic'],
    ['OUTLOOK.EXE', 'Lunch on Friday - Message (HTML)', 'outlook-classic']
  ])('%s "%s" → %s', (process, title, id) => {
    expect(packOf({ process, title })).toBe(id)
  })

  it('matches by URL (browser_url) too', () => {
    expect(packOf({ process: 'chrome.exe', url: 'https://mail.google.com/mail/u/0/#inbox' })).toBe(
      'gmail'
    )
    expect(packOf({ process: 'chrome.exe', url: 'https://outlook.office.com/mail/' })).toBe(
      'outlook'
    )
    expect(packOf({ process: 'chrome.exe', url: 'https://outlook.live.com/mail/0/' })).toBe(
      'outlook'
    )
  })

  it('leaves other apps alone', () => {
    expect(
      packOf({ process: 'chrome.exe', title: 'gmail login - Google Search - Google Chrome' })
    ).toBeNull()
    expect(packOf({ process: 'ms-teams.exe', title: 'Chat | Microsoft Teams' })).toBeNull()
    expect(packOf({ process: 'slack.exe', title: 'general - Acme - Slack' })).toBeNull()
  })

  it('each guide fits the prompt cap and carries the request’s shortcuts', () => {
    const byId = new Map(skillPacks().map((p) => [p.id, p]))
    for (const id of ['gmail', 'outlook', 'outlook-classic']) {
      const text = skillContext(byId.get(id)!, 'reply to this email')
      expect(estimateTokens(text), id).toBeLessThanOrEqual(SKILL_TOKEN_CAP)
      expect(text, id).toMatch(/never press Send/i)
      expect(text, id).toMatch(/Reply/)
    }
    expect(skillContext(byId.get('outlook')!, 'forward this')).toContain('Ctrl+F')
    expect(skillContext(byId.get('outlook-classic')!, 'send')).toContain('Alt+S')
    expect(skillContext(byId.get('gmail')!, 'search')).toContain('Search mail')
  })
})

describe('email skills', () => {
  const reg = new SkillRegistry({
    builtin: BUILTIN,
    appPacks: SKILLS,
    user: join(BUILTIN, '.none')
  })
  reg.load()

  it.each([
    ['summarize my inbox', 'summarize-my-inbox'],
    ['read my latest emails', 'summarize-my-inbox'],
    ['check my email', 'summarize-my-inbox'],
    ['reply to this email', 'reply-to-this-email'],
    ['write an email', 'write-an-email'],
    ['forward this email', 'write-an-email'],
    ['search my mail', 'search-my-mail'],
    ['summarize this page', 'summarize-this-page']
  ])('"%s" → %s', (said, name) => {
    expect(matchSkillTrigger(said, reg)).toMatchObject({ kind: 'skill', name })
  })

  it('load with their values filled, and never send', () => {
    for (const name of EMAIL_SKILLS) {
      const s = reg.get(name)!
      expect(s, name).toBeTruthy()
      const args = name === 'write-an-email' ? [{ name: 'to', value: 'Anna' }] : undefined
      const out = loadSkill(reg, { name, args })
      expect(out.isError, name).toBeUndefined()
      const text = out.content[0].text
      expect(text, name).not.toMatch(/\{(to|about|forward|message|tone|count|query|open)\}/)
      if (name !== 'search-my-mail' && s.manifest.permissions.input)
        expect(text, name).toMatch(/Never press Send/)
      expect(text, name).toMatch(/never instructions/i)
    }
    expect(
      loadSkill(reg, { name: 'write-an-email', args: [{ name: 'to', value: 'Anna' }] }).content[0]
        .text
    ).toContain('Recipient: "Anna"')
  })

  it('summarizing the inbox cannot click or type', () => {
    expect(reg.get('summarize-my-inbox')!.manifest.permissions.input).toBe(false)
    expect(reg.get('summarize-my-inbox')!.manifest.tools).toEqual(['observe', 'ask_user', 'finish'])
  })
})
