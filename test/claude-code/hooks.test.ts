import { request } from 'http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HookServer, type HookCall } from '../../src/main/claude-code/hook-server'
import {
  applyHooks,
  hasLumenHooks,
  lineDiff,
  previewHooks,
  sessionSettings,
  withLumenHooks,
  withoutLumenHooks
} from '../../src/main/claude-code/hooks-config'

const TOKEN = 'a'.repeat(64)

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = { 'x-lumen-token': TOKEN }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers }
      },
      (res) => {
        let data = ''
        res.on('data', (d) => (data += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('HookServer', () => {
  let server: HookServer
  const calls: HookCall[] = []
  beforeEach(async () => {
    calls.length = 0
    server = new HookServer(TOKEN, async (c) => {
      calls.push(c)
      if (c.payload.boom) throw new Error('boom')
      return { ok: c.event }
    })
    await server.start()
  })
  afterEach(() => server.stop())

  it('routes session and global hooks with the token', async () => {
    const r = await post(
      server.port,
      '/lumen-hook/s/cc_abc123/PermissionRequest',
      '{"tool_name":"Bash"}'
    )
    expect(r).toEqual({ status: 200, body: '{"ok":"PermissionRequest"}' })
    expect(calls[0]).toMatchObject({
      scope: 'session',
      sessionKey: 'cc_abc123',
      event: 'PermissionRequest'
    })
    const g = await post(server.port, '/lumen-hook/g/Stop', '{}')
    expect(g.status).toBe(200)
    expect(calls[1]).toMatchObject({ scope: 'global', event: 'Stop' })
  })

  it('refuses a wrong token, browser origins, unknown paths and huge bodies', async () => {
    expect(
      (await post(server.port, '/lumen-hook/g/Stop', '{}', { 'x-lumen-token': 'b'.repeat(64) }))
        .status
    ).toBe(403)
    expect((await post(server.port, '/lumen-hook/g/Stop', '{}', {})).status).toBe(403)
    expect(
      (
        await post(server.port, '/lumen-hook/g/Stop', '{}', {
          'x-lumen-token': TOKEN,
          origin: 'https://evil.example'
        })
      ).status
    ).toBe(404)
    expect((await post(server.port, '/other', '{}')).status).toBe(404)
    expect((await post(server.port, '/lumen-hook/g/Nope', '{}')).status).toBe(404)
    expect((await post(server.port, '/lumen-hook/g/Stop', 'not json')).status).toBe(400)
    const big = JSON.stringify({ x: 'y'.repeat(1_100_000) })
    const r = await post(server.port, '/lumen-hook/g/Stop', big).catch(() => ({ status: 413 }))
    expect(r.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('answers {} when the handler throws', async () => {
    expect(await post(server.port, '/lumen-hook/g/Stop', '{"boom":true}')).toEqual({
      status: 200,
      body: '{}'
    })
  })

  it('falls back to a free port when the preferred one is taken', async () => {
    const other = new HookServer(TOKEN, async () => ({}))
    const port = await other.start(server.port)
    expect(port).not.toBe(server.port)
    other.stop()
  })
})

describe('hook settings', () => {
  it('per session: one http hook per event with the token header', () => {
    const s = JSON.stringify(sessionSettings('http://127.0.0.1:5000', 'cc_abc123', TOKEN))
    expect(s).toContain('http://127.0.0.1:5000/lumen-hook/s/cc_abc123/PermissionRequest')
    expect(s).toContain(`"X-Lumen-Token":"${TOKEN}"`)
    expect(s).toContain('/lumen-hook/s/cc_abc123/Stop')
  })

  it('adds and removes only Lumen’s global hooks', () => {
    const user = {
      model: 'opus',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }] }
    }
    const withL = withLumenHooks(user, 'http://127.0.0.1:5000', TOKEN)
    expect(hasLumenHooks(withL)).toBe(true)
    const stop = (withL.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(2)
    expect(Object.keys(withL.hooks as object).sort()).toEqual([
      'Notification',
      'Stop',
      'SubagentStop'
    ])
    // Installing twice does not duplicate.
    expect(withLumenHooks(withL, 'http://127.0.0.1:5000', TOKEN)).toEqual(withL)
    expect(withoutLumenHooks(withL)).toEqual(user)
    expect(withoutLumenHooks({ hooks: {} })).toEqual({})
  })

  it('diffs lines with context', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toBe('  a\n- b\n+ B\n  c')
    expect(lineDiff('', '{}')).toBe('+ {}')
  })
})

describe('global hooks file', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-cc-'))
    file = join(dir, 'settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('previews, then writes only the confirmed state, with a backup', () => {
    writeFileSync(file, '{"model":"opus"}')
    const p = previewHooks(true, 'http://127.0.0.1:5000', TOKEN, 5000, file)
    expect(p.installed).toBe(false)
    expect(p.diff).toContain('- {"model":"opus"}')
    expect(p.diff).toContain('+   "hooks": {')
    expect(applyHooks(true, 'f'.repeat(64), 'http://127.0.0.1:5000', TOKEN, file).ok).toBe(false)
    expect(applyHooks(true, p.hash, 'http://127.0.0.1:5000', TOKEN, file)).toEqual({ ok: true })
    expect(existsSync(`${file}.lumen-bak`)).toBe(true)
    const now = JSON.parse(readFileSync(file, 'utf8'))
    expect(hasLumenHooks(now)).toBe(true)
    expect(previewHooks(false, 'http://127.0.0.1:6000', TOKEN, 6000, file)).toMatchObject({
      installed: true,
      stale: true
    })
    const un = previewHooks(false, 'http://127.0.0.1:5000', TOKEN, 5000, file)
    expect(applyHooks(false, un.hash, '', TOKEN, file).ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('creates the file when missing and refuses invalid JSON', () => {
    const p = previewHooks(true, 'http://127.0.0.1:5000', TOKEN, 5000, file)
    expect(applyHooks(true, p.hash, 'http://127.0.0.1:5000', TOKEN, file).ok).toBe(true)
    writeFileSync(file, '{oops')
    expect(applyHooks(true, p.hash, 'http://127.0.0.1:5000', TOKEN, file).ok).toBe(false)
  })
})
