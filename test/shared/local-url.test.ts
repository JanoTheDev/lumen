import { describe, expect, it } from 'vitest'
import { isLanUrl, isLoopbackUrl, localUrlAllowed } from '@shared/local-url'

describe('local server addresses', () => {
  it('knows this PC', () => {
    for (const u of ['http://localhost:11434', 'http://127.0.0.1:1234', 'http://[::1]:11434'])
      expect(isLoopbackUrl(u), u).toBe(true)
    for (const u of ['http://10.0.0.5:11434', 'https://example.com', 'ftp://127.0.0.1', 'nope'])
      expect(isLoopbackUrl(u), u).toBe(false)
  })

  it('knows the home network', () => {
    for (const u of [
      'http://192.168.1.20:11434',
      'http://172.20.0.2',
      'http://10.1.2.3',
      'http://nas.local:1234',
      'http://gpubox:11434',
      'http://[fd12:3456::1]:11434'
    ])
      expect(isLanUrl(u), u).toBe(true)
    for (const u of ['http://203.0.113.9', 'https://api.example.com', 'http://172.32.0.1'])
      expect(isLanUrl(u), u).toBe(false)
  })

  it('Local only takes loopback, and a LAN address only with the opt-in', () => {
    expect(localUrlAllowed('http://localhost:11434', false)).toBe(true)
    expect(localUrlAllowed('http://192.168.1.20:11434', false)).toBe(false)
    expect(localUrlAllowed('http://192.168.1.20:11434', true)).toBe(true)
    expect(localUrlAllowed('https://api.example.com', true)).toBe(false)
  })
})
