import { describe, expect, it } from 'vitest'
import type { AuditLine } from '@shared/channels'
import {
  auditOutcome,
  auditWhat,
  dayKey,
  grantLabel
} from '../src/renderer/src/panel/settings/sections/PrivacyAudit'

const line = (over: Partial<AuditLine> = {}): AuditLine => ({
  t: '2026-10-01T10:00:00.000Z',
  task: 't_1',
  origin: 'agent',
  action: { type: 'click' },
  risk: 'low',
  decision: 'auto',
  result: 'ok',
  ms: 3,
  ...over
})

describe('privacy action log wording', () => {
  it('names grant scopes', () => {
    expect(grantLabel('app:outlook.exe')).toBe('Outlook (app)')
    expect(grantLabel('domain:github.com')).toBe('github.com (site)')
    expect(grantLabel('scheme:mailto')).toBe('mailto links')
    expect(grantLabel('mcp:files/write_file')).toBe('write_file on files (connector)')
  })

  it('describes actions without typed text unless it was kept', () => {
    expect(auditWhat({ type: 'type', text: { len: 12, sha256: 'x' } })).toBe('Typed 12 characters')
    expect(auditWhat({ type: 'type', text: { len: 2, sha256: 'x', redacted: 'hi' } })).toBe(
      'Typed “hi”'
    )
    expect(auditWhat({ type: 'hotkey', keys: 'ctrl+s' })).toBe('Pressed ctrl+s')
    expect(auditWhat({ type: 'open_url', url: 'https://a.example' })).toBe(
      'Opened https://a.example'
    )
    expect(auditWhat({ type: 'click_element', element: 'Save' })).toBe('Click element “Save”')
    expect(auditWhat({ type: 'mcp_tool', tool: 'files/read' })).toBe('Used files/read')
  })

  it('says who decided and how it went', () => {
    expect(auditOutcome(line())).toBe('Allowed')
    expect(auditOutcome(line({ decision: 'confirmed-by-user', result: 'error' }))).toBe(
      'You said yes, failed'
    )
    expect(
      auditOutcome(line({ decision: 'blocked', result: 'denied', reason: 'never types here' }))
    ).toBe('Blocked: never types here')
  })

  it('day keys follow the UTC day files', () => {
    const now = new Date('2026-10-01T01:30:00.000Z')
    expect(dayKey(now)).toBe('2026-10-01')
    expect(dayKey(now, -1)).toBe('2026-09-30')
  })
})
