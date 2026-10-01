import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { pageSizeFor } from '../../src/main/docs-out/pdf'

describe('PDF page size (known gap)', () => {
  it('is Letter where the region uses it, else A4', () => {
    expect(pageSizeFor('en-US')).toBe('Letter')
    expect(pageSizeFor('es-MX')).toBe('Letter')
    expect(pageSizeFor('fr-CA')).toBe('Letter')
    expect(pageSizeFor('en_US.UTF-8')).toBe('Letter')
    expect(pageSizeFor('en-GB')).toBe('A4')
    expect(pageSizeFor('nl-NL')).toBe('A4')
    expect(pageSizeFor('zh-Hans-CN')).toBe('A4')
    expect(pageSizeFor('en')).toBe('A4')
    expect(pageSizeFor('')).toBe('A4')
    expect(pageSizeFor(undefined)).toBe('A4')
  })
})
