// Foreground fetch_url (05 T39): every fetch, fetched or refused, writes one action-log line.
import { describe, expect, it, vi } from 'vitest'
import type { ToolCtx } from '../../src/main/agent-mode/runner'
import { fetchUrlHandler, type FetchAudit } from '../../src/main/cards/fetch-tool'
import { WebError, type SafeGetResult } from '../../src/main/web/net'

const ctx = {
  task: () => ({ id: 't_abc' }),
  signal: new AbortController().signal
} as unknown as ToolCtx

describe('fetch_url action log', () => {
  it('logs each fetch once, including refused ones', async () => {
    const audit = vi.fn<FetchAudit>()
    const get = vi.fn(async (url: string): Promise<SafeGetResult> => {
      if (url.includes('robots')) throw new WebError('E_ROBOTS', 'no robots', url)
      if (url.includes('down')) throw new Error('connect failed')
      return { url, status: 200, contentType: 'text/html', body: '<p>Hi</p>', cut: false }
    })
    const h = fetchUrlHandler({ get, audit })
    await h({ url: 'https://ok.test/page?q=1' }, ctx)
    await h({ url: 'https://robots.test/x' }, ctx)
    await h({ url: 'https://down.test/x' }, ctx)
    expect(audit.mock.calls).toEqual([
      ['t_abc', { type: 'fetch_url', url: 'https://ok.test/page?q=1', status: 200 }, 'ok'],
      ['t_abc', { type: 'fetch_url', url: 'https://robots.test/x' }, 'denied', 'no robots'],
      ['t_abc', { type: 'fetch_url', url: 'https://down.test/x' }, 'error', 'connect failed']
    ])
  })
})
