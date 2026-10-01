import { describe, expect, it } from 'vitest'
import {
  checkEdit,
  diffSkill,
  editOfferLine,
  findSkill,
  matchEditIntent
} from '../../src/main/skills/edit'

const BEFORE = `---
name: morning
description: "Opens the mail."
triggers: ["good morning"]
permissions:
  input: true
---
1. Open Outlook.
2. Read the unread mail.
`

const AFTER = `---
name: morning
description: "Opens the mail and Slack."
triggers: ["good morning", "start my day"]
permissions:
  input: true
  network: ["https://app.slack.com"]
---
1. Open Outlook.
2. Read the unread mail.
3. Open Slack in the browser.
`

describe('voice edits of skills', () => {
  it('matches edit phrases', () => {
    expect(matchEditIntent('Change my morning skill to also open Slack')).toEqual({
      kind: 'edit',
      target: 'morning',
      change: 'also open slack'
    })
    expect(matchEditIntent('make the email skill more formal')).toEqual({
      kind: 'edit',
      target: 'email',
      change: 'make it more formal'
    })
    expect(matchEditIntent('update the export png skill')).toEqual({
      kind: 'update',
      target: 'export png'
    })
    expect(matchEditIntent('update it')).toEqual({ kind: 'update-last' })
    expect(matchEditIntent('make the text bigger')).toBeNull()
  })

  it('finds a skill by name, phrase or words, and asks when unsure', () => {
    const skills = [
      { name: 'good-morning', triggers: ['good morning'] },
      { name: 'reply-to-email', triggers: ['reply to this email'] },
      { name: 'email-summary', triggers: [] },
      { name: 'export-png', triggers: [] }
    ]
    expect(findSkill('good morning', skills)).toEqual({ name: 'good-morning' })
    expect(findSkill('morning', skills)).toEqual({ name: 'good-morning' })
    expect(findSkill('export png', skills)).toEqual({ name: 'export-png' })
    expect(findSkill('email', skills)).toEqual({
      ambiguous: ['reply-to-email', 'email-summary']
    })
    expect(findSkill('banana', skills)).toBeNull()
  })

  it('summarizes the diff, wider permissions first', () => {
    const d = diffSkill(BEFORE, AFTER)
    expect(d.widens).toBe(true)
    expect(d.lines[0]).toBe('It may now open https://app.slack.com.')
    expect(d.lines).toContain('New description: Opens the mail and Slack.')
    expect(d.lines).toContain('New phrases: “start my day”.')
    expect(d.lines).toContain('1 instruction line added, 0 removed.')
    expect(diffSkill(BEFORE, BEFORE).lines).toEqual([])
  })

  it('flags lost restrictions', () => {
    const scoped = BEFORE.replace('triggers:', 'apps: [outlook]\ntools: [observe, act]\ntriggers:')
    const d = diffSkill(
      scoped,
      BEFORE.replace('triggers:', 'tools: [observe, act, keys]\ntriggers:')
    )
    expect(d.lines).toEqual(
      expect.arrayContaining(['It now works in any app.', 'It may now use the tools keys.'])
    )
  })

  it('checks the model edit: valid, same name, a real change', () => {
    const ok = checkEdit(
      BEFORE,
      { skill_md: AFTER, summary: 'It now also opens Slack.', steps_still_match: true },
      { hasSteps: true }
    )
    expect(ok.ok && ok.dropSteps).toBe(false)
    const renamed = checkEdit(
      BEFORE,
      {
        skill_md: AFTER.replace('name: morning', 'name: evening'),
        summary: '',
        steps_still_match: true
      },
      { hasSteps: false }
    )
    expect(renamed).toEqual({ ok: false, error: 'the AI tried to rename the skill' })
    expect(
      checkEdit(
        BEFORE,
        { skill_md: 'nonsense', summary: '', steps_still_match: true },
        { hasSteps: false }
      ).ok
    ).toBe(false)
    expect(
      checkEdit(
        BEFORE,
        { skill_md: BEFORE, summary: '', steps_still_match: true },
        { hasSteps: false }
      )
    ).toEqual({ ok: false, error: 'nothing changed' })
    // Same text but the steps no longer fit: still a change (the steps go).
    const drop = checkEdit(
      BEFORE,
      { skill_md: `\`\`\`markdown\n${BEFORE}\`\`\``, summary: 'x', steps_still_match: false },
      { hasSteps: true }
    )
    expect(drop.ok && drop.dropSteps).toBe(true)
  })

  it('speaks the review line', () => {
    const d = diffSkill(BEFORE, AFTER)
    expect(
      editOfferLine('good-morning', {
        summary: 'It now also opens Slack.',
        diff: d,
        dropSteps: true
      })
    ).toMatch(
      /^Change to “good morning”: It now also opens Slack\. Its recorded steps are removed.* It may now open https:\/\/app\.slack\.com\..*Say “save it”/
    )
  })
})
