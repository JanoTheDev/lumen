import { describe, it, expect } from 'vitest'
import {
  findSensitive,
  ibanValid,
  isSensitive,
  luhn,
  redact
} from '../../src/main/ai/memory/sensitive'

describe('sensitive filter', () => {
  it.each([
    ['my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'api-key'],
    ['use sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234', 'api-key'],
    ['AKIAIOSFODNN7EXAMPLE', 'api-key'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'api-key'],
    ['api key = 9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'api-key'],
    ['card 4111 1111 1111 1111 expires soon', 'card'],
    ['5500-0000-0000-0004', 'card'],
    ['IBAN GB82 WEST 1234 5698 7654 32', 'iban'],
    ['DE89370400440532013000', 'iban'],
    ['my password is hunter2', 'password'],
    ['PIN: 4821', 'password'],
    ['the verification code is 482913', 'one-time-code'],
    ['ssn 123-45-6789', 'government-id'],
    ['passport number is X1234567', 'government-id'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'private-key']
  ])('flags %s', (text, kind) => {
    expect(findSensitive(text).map((h) => h.kind)).toContain(kind)
  })

  it.each([
    'My name is Jano',
    'I use dwell clicking',
    'Resolve project is 4K 25fps',
    'order 1234 5678 9012 3456 arrived',
    'Blender 4.2 hotkey preset',
    'call me at 3pm about lesson 3'
  ])('allows %s', (text) => {
    expect(isSensitive(text)).toBe(false)
  })

  it('checks card numbers with Luhn and IBANs with mod 97', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    expect(ibanValid('GB82WEST12345698765432')).toBe(true)
    expect(ibanValid('GB82WEST12345698765433')).toBe(false)
  })

  it('treats emails as sensitive only when asked', () => {
    expect(isSensitive('mail me at jano@example.com')).toBe(false)
    expect(isSensitive('mail me at jano@example.com', { emails: true })).toBe(true)
  })

  it('redacts spans in place', () => {
    expect(redact('pay with 4111111111111111 today')).toBe('pay with [redacted:card] today')
    expect(redact('password: hunter2 ok')).toBe('[redacted:password] ok')
  })
})
