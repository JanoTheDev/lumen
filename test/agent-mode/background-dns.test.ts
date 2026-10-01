import { describe, expect, it } from 'vitest'
import type { LookupAddress } from 'dns'
import {
  isPrivateHost,
  makeSafeLookup,
  pinnedFetch,
  type Resolver
} from '../../src/main/agent-mode/background/fetch'

const resolver =
  (map: Record<string, string[]>): Resolver =>
  (host, _opts, cb) => {
    const ips = map[host]
    if (!ips) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), [])
    cb(
      null,
      ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    )
  }

function lookup(
  map: Record<string, string[]>,
  host: string,
  opts: { all?: boolean } = {}
): Promise<{ err: (Error & { code?: string }) | null; address: string | LookupAddress[] }> {
  const fn = makeSafeLookup(resolver(map))
  return new Promise((resolve) =>
    fn(host, opts, (err, address) => resolve({ err: err as Error & { code?: string }, address }))
  )
}

describe('connect-time DNS check (rebinding)', () => {
  const map = {
    'example.com': ['93.184.215.14'],
    'rebind.example': ['10.0.0.7'],
    'mixed.example': ['93.184.215.14', '127.0.0.1'],
    'v6.example': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'v6local.example': ['fe80::1'],
    'mapped.example': ['::ffff:192.168.1.1'],
    'meta.example': ['169.254.169.254']
  }

  it('passes public addresses (single and all)', async () => {
    expect(await lookup(map, 'example.com')).toEqual({ err: null, address: '93.184.215.14' })
    const all = await lookup(map, 'v6.example', { all: true })
    expect(all.err).toBeNull()
    expect(all.address).toEqual([{ address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }])
  })

  it('refuses a public name that resolves to a private, loopback or link-local address', async () => {
    for (const host of [
      'rebind.example',
      'mixed.example',
      'v6local.example',
      'mapped.example',
      'meta.example'
    ]) {
      const r = await lookup(map, host)
      expect(r.err?.message, host).toMatch(/blocked local address/)
      expect(r.err?.code, host).toBe('E_DENIED')
    }
  })

  it('the https fetch refuses at connect time (no request is sent)', async () => {
    const f = pinnedFetch(makeSafeLookup(resolver(map)))
    await expect(f('https://rebind.example/admin', {})).rejects.toThrow(/blocked local address/)
  })

  it('passes resolver errors through', async () => {
    expect((await lookup(map, 'nope.example')).err?.message).toBe('ENOTFOUND')
  })

  it('classifies extra reserved ranges', () => {
    for (const ip of ['224.0.0.1', '255.255.255.255', '198.18.0.1', 'ff02::1'])
      expect(isPrivateHost(ip), ip).toBe(true)
  })
})
