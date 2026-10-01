// Email safety (08 email): Send, delete and spam always confirm in Gmail, new Outlook and
// classic Outlook, by name, by shortcut or by a focused button; a recipient always shows on the
// card, and one the user never said is high risk.
import { describe, expect, it } from 'vitest'
import {
  evaluate,
  isMail,
  isRecipientField,
  type Decision,
  type EvalAction,
  type PolicyCtx,
  type WindowInfo
} from '../../src/main/actions/safety'
import { riskyName } from '../../src/main/actions/risk-names'

const GMAIL: WindowInfo = {
  title: 'Inbox (3) - jip@example.com - Gmail - Google Chrome',
  process: 'chrome.exe',
  focusKnown: true
}
const NEW_OUTLOOK: WindowInfo = {
  title: 'Mail - Jan Om - Outlook',
  process: 'olk.exe',
  focusKnown: true
}
const CLASSIC: WindowInfo = {
  title: 'Untitled - Message (HTML)',
  process: 'OUTLOOK.EXE',
  focusKnown: true
}
const SURFACES = { gmail: GMAIL, 'new outlook': NEW_OUTLOOK, 'classic outlook': CLASSIC }

const agent = (
  w: WindowInfo,
  focus: Partial<WindowInfo> = {},
  more: Partial<PolicyCtx> = {}
): PolicyCtx => ({ origin: 'agent', activeWindow: { ...w, ...focus }, ...more }) as PolicyCtx
const rate = (a: EvalAction, ctx: PolicyCtx): Decision => evaluate(a, ctx)
const keys = (combo: string, ctx: PolicyCtx): Decision => rate({ type: 'hotkey', keys: combo }, ctx)

describe('email windows', () => {
  it('tells mail apps from other windows', () => {
    for (const w of Object.values(SURFACES)) expect(isMail(w)).toBe(true)
    expect(isMail({ title: 'Mail - Jan - Outlook - Google Chrome', process: 'chrome.exe' })).toBe(
      true
    )
    expect(isMail({ title: 'general | Slack', process: 'slack.exe' })).toBe(false)
    expect(isMail({ title: 'Untitled - Notepad', process: 'notepad.exe' })).toBe(false)
  })

  it('knows the recipient boxes of each app', () => {
    for (const n of ['To recipients', 'To', 'Cc', 'Bcc', 'Cc recipients'])
      expect(isRecipientField(n)).toBe(true)
    for (const n of ['Subject', 'Add a subject', 'Message Body', 'Search mail', 'Today'])
      expect(isRecipientField(n)).toBe(false)
  })

  it('rates the email control names', () => {
    expect(riskyName('Send (Ctrl-Enter)')).toBe('send')
    expect(riskyName('Discard draft (Ctrl-Shift-D)')).toBe('discard draft')
    expect(riskyName('Delete forever')).toBe('delete forever')
    expect(riskyName('Report spam')).toBe('report spam')
    expect(riskyName('Move to Trash')).toBe('move to trash')
    expect(riskyName('Sender')).toBeNull()
    expect(riskyName('Archive')).toBeNull()
    expect(riskyName('Mark as read')).toBeNull()
  })
})

describe.each(Object.entries(SURFACES))('%s', (_name, w) => {
  it('clicking Send always confirms, even with a grant', () => {
    const d = rate(
      { type: 'uia_act', action: 'invoke', description: 'Send' },
      { ...agent(w), grants: { has: () => true } }
    )
    expect(d).toMatchObject({ risk: 'high', needsConfirm: true })
  })

  it('Ctrl+Enter sends and confirms', () => {
    expect(
      keys('ctrl+enter', agent(w, { focusRole: 'edit', focusName: 'Message Body' }))
    ).toMatchObject({
      risk: 'high',
      reason: 'sends the message'
    })
  })

  it('Enter on a focused Send button confirms; Enter in the body does not', () => {
    expect(keys('enter', agent(w, { focusRole: 'button', focusName: 'Send' })).risk).toBe('high')
    expect(keys('space', agent(w, { focusRole: 'button', focusName: 'Send' })).risk).toBe('high')
    expect(keys('enter', agent(w, { focusRole: 'edit', focusName: 'Message Body' })).risk).toBe(
      'low'
    )
  })

  it('Enter in To, Subject or Search picks or searches: not a send', () => {
    for (const focusName of ['To recipients', 'To', 'Subject', 'Add a subject', 'Search mail'])
      expect(
        rate(
          { type: 'hotkey', keys: 'enter' },
          { ...agent(w, { focusRole: 'edit', focusName }), prevType: 'type' }
        ).risk
      ).not.toBe('high')
  })

  it('delete keys on the message list confirm; in a text box they edit', () => {
    const list = { focusRole: 'dataitem', focusName: 'From Anna Berg Subject Lunch' }
    for (const combo of ['delete', 'shift+delete', 'ctrl+d'])
      expect(keys(combo, agent(w, list))).toMatchObject({
        risk: 'high',
        reason: 'deletes the email'
      })
    expect(keys('delete', agent(w, { focusRole: 'edit', focusName: 'Subject' })).risk).toBe('low')
  })

  it('a recipient the user named shows on the card; a guessed one is high', () => {
    const to = { focusRole: 'edit', focusName: w === GMAIL ? 'To recipients' : 'To' }
    const named = rate(
      { type: 'type', text: 'Anna' },
      agent(w, to, { userText: 'email Anna about lunch' })
    )
    expect(named).toMatchObject({ risk: 'medium', needsConfirm: true })
    expect(named.reason).toContain('fills the recipient “Anna”')
    const guessed = rate(
      { type: 'type', text: 'anna.berg@acme-corp.example' },
      agent(w, to, { userText: 'email Anna about lunch' })
    )
    expect(guessed).toMatchObject({ risk: 'high', needsConfirm: true })
    expect(guessed.reason).toContain('did not name')
    // The same rule for set_value on the To element (the policy reads its name).
    const set = rate(
      { type: 'uia_act', action: 'set_value', value: 'bob@example.com', description: to.focusName },
      agent(w, {}, { userText: 'email Anna' })
    )
    expect(set.risk).toBe('high')
  })

  it('the body and subject are not recipients', () => {
    const d = rate(
      { type: 'type', text: 'Hi Anna, lunch on Friday works.' },
      agent(w, { focusRole: 'edit', focusName: 'Message Body' }, { userText: 'email Anna' })
    )
    expect(d.risk).toBe('low')
  })
})

describe('per app', () => {
  it('Gmail: # deletes and ! reports spam on the list, typed or pressed', () => {
    const row = { focusRole: 'dataitem', focusName: 'unread, Anna Berg, Lunch on Friday' }
    expect(keys('#', agent(GMAIL, row)).reason).toBe('deletes the email')
    expect(keys('shift+3', agent(GMAIL, row)).risk).toBe('high')
    expect(keys('!', agent(GMAIL, row)).reason).toBe('reports the email as spam')
    expect(rate({ type: 'type', text: '#' }, agent(GMAIL, row)).risk).toBe('high')
    expect(
      rate(
        { type: 'type', text: '#' },
        agent(GMAIL, { focusRole: 'edit', focusName: 'Message Body' })
      ).risk
    ).toBe('low')
    // Archive (e) and reply (r) stay low.
    expect(keys('e', agent(GMAIL, row)).risk).toBe('low')
    expect(keys('r', agent(GMAIL, row)).risk).toBe('low')
  })

  it('classic Outlook: Alt+S sends', () => {
    expect(
      keys('alt+s', agent(CLASSIC, { focusRole: 'document', focusName: 'Message' }))
    ).toMatchObject({
      risk: 'high',
      reason: 'sends the email'
    })
    expect(keys('alt+s', agent({ title: 'Untitled - Notepad', process: 'notepad.exe' })).risk).toBe(
      'low'
    )
  })

  it('allowSendWithoutReview: sending is medium with a countdown, still on the card; delete stays high', () => {
    const ctx = agent(
      CLASSIC,
      { focusRole: 'document', focusName: 'Message' },
      { allowSendWithoutReview: true }
    )
    expect(keys('alt+s', ctx)).toMatchObject({ risk: 'medium', needsConfirm: true })
    expect(rate({ type: 'uia_act', action: 'invoke', description: 'Send' }, ctx).risk).toBe(
      'medium'
    )
    expect(rate({ type: 'uia_act', action: 'invoke', description: 'Delete' }, ctx).risk).toBe(
      'high'
    )
  })

  it('the user dictating into a mail app is never second-guessed on recipients', () => {
    const d = rate(
      { type: 'type', text: 'bob@example.com' },
      {
        origin: 'user-direct',
        activeWindow: { ...GMAIL, focusRole: 'edit', focusName: 'To recipients' }
      }
    )
    expect(d.risk).toBe('low')
  })

  it('Enter on a list row never counts as pressing its subject words', () => {
    const row = { focusRole: 'listitem', focusName: 'Unread Anna Berg Please delete the old files' }
    expect(keys('enter', agent(NEW_OUTLOOK, row)).risk).toBe('low')
  })
})

describe('localized mail UIs (nl, de, fr, es)', () => {
  const LOCAL: [string, string, string, string][] = [
    // [send, delete, to, spam]
    ['Verzenden', 'Verwijderen', 'Aan', 'Spam melden'],
    ['Senden', 'Löschen', 'An', 'Spam melden'],
    ['Envoyer', 'Supprimer', 'À', 'Signaler comme spam'],
    ['Enviar', 'Eliminar', 'Para', 'Denunciar spam']
  ]
  const surfaces = { gmail: GMAIL, 'new outlook': NEW_OUTLOOK }
  for (const [sendName, del, to, spam] of LOCAL)
    for (const [surface, w] of Object.entries(surfaces))
      it(`${surface}: ${sendName} / ${del} / ${spam} / ${to}`, () => {
        for (const name of [sendName, del, spam])
          expect(rate({ type: 'click_element', elementName: name }, agent(w)).risk).toBe('high')
        expect(keys('enter', agent(w, { focusRole: 'button', focusName: sendName })).risk).toBe(
          'high'
        )
        expect(isRecipientField(to)).toBe(true)
        expect(
          rate(
            { type: 'type', text: 'eve@evil.example' },
            agent(w, { focusRole: 'edit', focusName: to }, { userText: 'mail Anna' })
          ).risk
        ).toBe('high')
      })

  it('allowSendWithoutReview covers localized Send; local subject boxes are not a send', () => {
    const ctx = agent(NEW_OUTLOOK, {}, { allowSendWithoutReview: true })
    expect(rate({ type: 'click_element', elementName: 'Verzenden' }, ctx).risk).toBe('medium')
    for (const focusName of ['Onderwerp', 'Betreff', 'Objet', 'Asunto', 'Zoeken'])
      expect(
        rate(
          { type: 'hotkey', keys: 'enter' },
          { ...agent(GMAIL, { focusRole: 'edit', focusName }), prevType: 'type' }
        ).risk
      ).not.toBe('high')
    expect(riskyName('Versenden')).toBeNull()
    expect(isRecipientField('Antwoorden')).toBe(false)
  })
})

it('the confirm card shows the localized word as written', () => {
  expect(riskyName('Endgültig löschen')).toBe('endgültig löschen')
  expect(riskyName('ENVOYER')).toBe('envoyer')
})

describe('recipient autocomplete and paste', () => {
  const user = { userText: 'email john about lunch' }
  for (const [surface, w] of Object.entries(SURFACES)) {
    const to = { focusRole: 'edit', focusName: w === GMAIL ? 'To recipients' : 'To' }
    it(`${surface}: a typed prefix is not "named"; picking an unnamed suggestion is high`, () => {
      expect(rate({ type: 'type', text: 'j' }, agent(w, to, user)).risk).toBe('high')
      expect(rate({ type: 'type', text: 'john' }, agent(w, to, user)).risk).toBe('medium')
      for (const a of [
        { type: 'click_element', elementName: 'Eve Evil eve@evil.example' },
        { type: 'uia_act', action: 'invoke', description: 'Eve Evil eve@evil.example' },
        { type: 'click_element', elementName: 'Eve Evil' }
      ])
        expect(rate(a, agent(w, to, user))).toMatchObject({ risk: 'high', needsConfirm: true })
      // A suggestion row with an address is a recipient pick even when focus moved to the list.
      expect(
        rate(
          { type: 'click_element', elementName: 'Eve Evil eve@evil.example' },
          agent(w, { focusRole: 'listitem', focusName: 'Eve Evil' }, user)
        ).risk
      ).toBe('high')
    })

    it(`${surface}: Enter / Tab in To pick a suggestion (not low); paste into To is high`, () => {
      const ctx = { ...agent(w, to, user), prevType: 'type' }
      for (const combo of ['enter', 'tab'])
        expect(rate({ type: 'hotkey', keys: combo }, ctx).risk).not.toBe('low')
      expect(keys('ctrl+v', agent(w, to, user)).risk).toBe('high')
      expect(keys('shift+insert', agent(w, to, user)).risk).toBe('high')
      expect(
        rate(
          { type: 'input', steps: [{ t: 'keys', combo: 'ctrl+v' }] } as EvalAction,
          agent(w, to, user)
        ).risk
      ).toBe('high')
    })
  }

  it('a suggestion the user named in full (or by address) is on the card, not high', () => {
    const w = GMAIL
    const to = { focusRole: 'edit', focusName: 'To recipients' }
    expect(
      rate(
        { type: 'click_element', elementName: 'John Smith john@corp.example' },
        agent(w, to, { userText: 'email John Smith about lunch' })
      ).risk
    ).toBe('medium')
    expect(
      rate(
        { type: 'click_element', elementName: 'John Smith john@corp.example' },
        agent(w, to, { userText: 'mail john@corp.example the notes' })
      ).risk
    ).toBe('medium')
    // Half the name is not the whole name.
    expect(
      rate(
        { type: 'click_element', elementName: 'John Evil john@evil.example' },
        agent(w, to, user)
      ).risk
    ).toBe('high')
    // Clicking the subject or body from To is not a pick.
    for (const elementName of ['Subject', 'Message Body'])
      expect(rate({ type: 'click_element', elementName }, agent(w, to, user)).risk).toBe('low')
  })

  it('the user clicking a suggestion themselves is not second-guessed', () => {
    const d = rate(
      { type: 'click_element', elementName: 'Eve Evil eve@evil.example' },
      { origin: 'user-direct', activeWindow: { ...GMAIL, focusName: 'To recipients' } }
    )
    expect(d.risk).toBe('low')
  })
})
