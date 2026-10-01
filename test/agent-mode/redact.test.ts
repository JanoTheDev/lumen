import { describe, it, expect, vi } from 'vitest'
import {
  findSecrets,
  maskSecrets,
  redactForLog,
  redactForModel
} from '../../src/main/actions/redact'

// Built from pieces so the fixtures do not look like real keys to secret scanners.
const KEY = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrSt'].join('-')
const AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const GH = ['ghp', 'a1B2'.repeat(9)].join('_')
const SLACK = ['xoxb', '123456789012', 'abcdefghij'].join('-')
const JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
].join('.')
const PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`
const CARD = '4242 4242 4242 4242'
const IBAN = 'DE89 3704 0044 0532 0130 00'

describe('findSecrets', () => {
  it.each([
    ['openai key', KEY, 'api-key'],
    ['aws key', AWS, 'api-key'],
    ['github token', GH, 'api-key'],
    ['slack token', SLACK, 'api-key'],
    ['jwt', JWT, 'api-key'],
    ['pem block', PEM, 'private-key'],
    ['card (Luhn)', CARD, 'card'],
    ['iban', IBAN, 'iban']
  ])('finds a %s', (_label, secret, kind) => {
    const hits = findSecrets(`here: ${secret} done`)
    expect(hits.map((h) => h.kind)).toEqual([kind])
    expect(hits[0].masked).not.toContain(secret.slice(4, 12))
  })

  it.each([
    ['short hex hash', 'commit 3f2a9c1d7e5b4a60 fixed it'],
    ['31-char hex', 'id 0123456789abcdef0123456789abcde'],
    ['sha256 hex', `sum ${'ab'.repeat(32)}`],
    ['non-Luhn digits', 'order 4242 4242 4242 4241'],
    ['phone number', 'call +49 30 123456789'],
    ['invalid iban checksum', 'DE00 3704 0044 0532 0130 00'],
    ['plain prose', 'please send the report to my boss tomorrow'],
    ['uuid', '123e4567-e89b-12d3-a456-426614174000']
  ])('ignores a %s', (_label, text) => {
    expect(findSecrets(text)).toEqual([])
  })

  it('masks cards and ibans to their last four', () => {
    expect(maskSecrets(`card ${CARD}`)).toBe('card •••• 4242')
    expect(maskSecrets(`to ${IBAN}`)).toBe('to DE•• •••• 3000')
  })
})

describe('redactForLog / redactForModel', () => {
  it('replaces secrets with [redacted:kind]', () => {
    expect(redactForLog(`using ${KEY} now`)).toBe('using [redacted:api-key] now')
    expect(redactForModel(`pay with ${CARD}`)).toBe('pay with [redacted:card]')
  })

  it('leaves ordinary text alone', () => {
    const line = 'execute: click, type | image 1280x720 → phys 2560x1440'
    expect(redactForLog(line)).toBe(line)
  })
})

describe('logger hook', () => {
  it('log() redacts secrets before printing', async () => {
    const { log } = await import('../../src/main/logger')
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l))
    try {
      log('step', `typing ${KEY}`)
    } finally {
      spy.mockRestore()
    }
    expect(lines[0]).toContain('typing [redacted:api-key]')
    expect(lines[0]).not.toContain(KEY)
  })
})
