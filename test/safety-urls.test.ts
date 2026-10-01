// URL policy gaps not covered by safety.test.ts / agent-mode/safety.test.ts: case and
// whitespace tricks, scheme-relative and IDN hosts, for both the old helper and evaluate().
import { describe, it, expect } from 'vitest'
import {
  assertLaunchableUrl,
  evaluate,
  isSafeUrl,
  newTaskState,
  type PolicyCtx
} from '../src/main/actions/safety'

const ctx: PolicyCtx = { origin: 'user-direct' }
const risk = (url: string, c: PolicyCtx = ctx): string =>
  evaluate({ type: 'open_url', url }, c).risk

describe('URL tricks are rejected everywhere', () => {
  it.each([
    'FILE:///C:/Windows/System32/calc.exe',
    'File://host/share/x.exe',
    'JavaScript:alert(1)',
    'jAvAsCrIpT:alert(1)',
    'DATA:text/html,<b>x</b>',
    'MS-MSDT:/id PCWDiagnostic',
    'Search-MS:query=x',
    'ms-officecmd:{"id":3}',
    '//evil.example/share/x.exe',
    '\\\\evil\\share\\x.exe',
    '\\\\?\\C:\\Windows\\notepad.exe',
    '  file:///C:/x',
    '\tjavascript:alert(1)',
    'java\nscript:alert(1)',
    'https://user@example.com/',
    'https://:pw@example.com/',
    'HTTPS://user:pw@example.com/',
    'https:\\\\example.com\\x',
    'https://',
    'notaurl',
    'x'.repeat(5000)
  ])('%j', (url) => {
    expect(isSafeUrl(url)).toBe(false)
    expect(risk(url)).toBe('blocked')
    expect(() => assertLaunchableUrl(url)).toThrow()
  })
})

describe('ordinary web addresses are allowed', () => {
  it.each([
    'https://example.com/',
    'HTTPS://EXAMPLE.COM/Path',
    'http://example.com:8080/a?b=c#d',
    '  https://example.com/  ',
    'https://bücher.de/',
    'https://xn--bcher-kva.de/',
    'https://日本.jp/',
    'https://例え.テスト/パス?q=値'
  ])('%j', (url) => {
    expect(isSafeUrl(url)).toBe(true)
    expect(risk(url)).toBe('low')
    expect(() => assertLaunchableUrl(url)).not.toThrow()
  })

  it('leading control characters are stripped by the URL parser, not passed on', () => {
    expect(assertLaunchableUrl('\u0000\u001f https://example.com/')).toBe('https://example.com/')
  })

  it('normalizes IDN hosts to punycode for the launcher', () => {
    expect(assertLaunchableUrl('https://bücher.de/')).toBe('https://xn--bcher-kva.de/')
  })

  // siteOf keeps the last two labels, so a grant for mail.example.co.uk covers every .co.uk
  // site. See 10-quality/tasks.md Notes (needs a small public-suffix table in safety.ts).
  it.fails('a new site on an agent task is grantable per registrable domain', () => {
    const d = evaluate(
      { type: 'open_url', url: 'https://mail.example.co.uk/x' },
      { origin: 'agent', task: newTaskState() }
    )
    expect(d.risk).toBe('medium')
    expect(d.grantScope).toBe('domain:example.co.uk')
  })
})
