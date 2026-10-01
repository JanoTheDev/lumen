import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@shared/types'
import {
  assertFetchable,
  fetchPage,
  htmlToText,
  isPrivateHost,
  type FetchImpl
} from '../../src/main/agent-mode/background/fetch'
import { readGranted } from '../../src/main/agent-mode/background/files'
import { doneLine, noticeVerdict, PRESENT_MS } from '../../src/main/agent-mode/background/presence'
import { networkAllows } from '../../src/main/agent-mode/background/skills'
import { parseTask, TaskStore } from '../../src/main/agent-mode/background/store'
import { backgroundToolDefs } from '../../src/main/agent-mode/background/tools'

const dir = mkdtempSync(join(tmpdir(), 'lumen-bg-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('fetch_url policy', () => {
  it('blocks local and private hosts', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.20.1.1',
      '169.254.169.254',
      '[::1]',
      'printer',
      'nas.local',
      'fd00::1'
    ])
      expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['example.com', '8.8.8.8', 'news.ycombinator.com', '172.32.0.1'])
      expect(isPrivateHost(h), h).toBe(false)
  })

  it('only https, no credentials, no private hosts', () => {
    expect(assertFetchable('https://example.com/a').hostname).toBe('example.com')
    expect(() => assertFetchable('http://example.com')).toThrow(/https/)
    expect(() => assertFetchable('file:///C:/x')).toThrow()
    expect(() => assertFetchable('https://u:p@example.com')).toThrow()
    expect(() => assertFetchable('https://127.0.0.1/admin')).toThrow(/local/)
  })

  it('checks every redirect hop', async () => {
    const impl: FetchImpl = async (url) =>
      url.includes('example.com')
        ? new Response(null, { status: 302, headers: { location: 'https://192.168.0.1/' } })
        : new Response('secret')
    await expect(
      fetchPage('https://example.com', new AbortController().signal, impl)
    ).rejects.toThrow(/local/)
  })

  it('follows a safe redirect and returns page text', async () => {
    const impl: FetchImpl = async (url) =>
      url === 'https://example.com/'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('<html><script>x()</script><p>Hello &amp; welcome</p><p>Two</p></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          })
    const page = await fetchPage('https://example.com/', new AbortController().signal, impl)
    expect(page.url).toBe('https://example.com/new')
    expect(page.text).toBe('Hello & welcome\nTwo')
  })

  it('htmlToText drops scripts, styles and tags', () => {
    expect(htmlToText('<style>a{}</style><h1>T</h1><div>a&nbsp;b &#65;</div>')).toBe('T\na b A')
  })
})

describe('read_file grants', () => {
  const granted = join(dir, 'granted')
  const other = join(dir, 'other')
  mkdirSync(granted, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(granted, 'notes.txt'), 'hello')
  writeFileSync(join(granted, 'app.exe'), 'MZ')
  writeFileSync(join(other, 'secret.txt'), 'no')

  it('reads text files inside a granted folder only', () => {
    expect(readGranted(join(granted, 'notes.txt'), [granted])).toMatchObject({
      ok: true,
      text: 'hello'
    })
    expect(readGranted(join(other, 'secret.txt'), [granted])).toMatchObject({ ok: false })
    expect(readGranted(join(granted, '..', 'other', 'secret.txt'), [granted])).toMatchObject({
      ok: false
    })
    expect(readGranted(join(granted, 'app.exe'), [granted])).toMatchObject({ ok: false })
    expect(readGranted('notes.txt', [granted])).toMatchObject({ ok: false })
    expect(readGranted(join(granted, 'notes.txt'), [])).toMatchObject({ ok: false })
  })
})

describe('skill network patterns', () => {
  it('matches host wildcards and paths', () => {
    expect(networkAllows(['https://*.youtube.com'], 'https://www.youtube.com/watch?v=1')).toBe(true)
    expect(networkAllows(['https://*.youtube.com'], 'https://youtube.com/')).toBe(true)
    expect(networkAllows(['https://*.youtube.com'], 'https://evil-youtube.com/')).toBe(false)
    expect(networkAllows(['https://api.example.com/v1/*'], 'https://api.example.com/v1/x')).toBe(
      true
    )
    expect(networkAllows(['https://api.example.com/v1/*'], 'https://api.example.com/v2/x')).toBe(
      false
    )
    expect(networkAllows([], 'https://example.com/')).toBe(false)
  })
})

describe('presence rule', () => {
  it('speaks only while the user is around and not in focus mode', () => {
    expect(noticeVerdict({ idleMs: 1000, quiet: false, midTurn: false })).toBe('now')
    expect(noticeVerdict({ idleMs: 1000, quiet: false, midTurn: true })).toBe('after-turn')
    expect(noticeVerdict({ idleMs: PRESENT_MS, quiet: false, midTurn: false })).toBe('list-only')
    expect(noticeVerdict({ idleMs: 0, quiet: true, midTurn: false })).toBe('list-only')
  })

  it('done line is short', () => {
    expect(doneLine('Compare laptops', 'done', 'The X1 is cheapest. More in the list.')).toBe(
      'Background task done: Compare laptops. The X1 is cheapest.'
    )
  })
})

describe('task store', () => {
  const task: BackgroundTask = {
    id: 'bg_abc123',
    title: 'T',
    prompt: 'p',
    origin: 'voice',
    phase: 'done',
    progress: ['a'],
    counters: { modelCalls: 1, costUsd: 0, startedAt: 1 }
  }

  it('saves, loads and removes one file per task', () => {
    const s = new TaskStore(join(dir, 'tasks'))
    s.save(task)
    s.save({ ...task, id: '../evil' })
    writeFileSync(join(dir, 'tasks', 'junk.json'), '{')
    expect(s.load()).toEqual([task])
    s.remove(task.id)
    expect(s.load()).toEqual([])
  })

  it('rejects malformed tasks', () => {
    expect(parseTask({ ...task, phase: 'weird' })).toBeNull()
    expect(parseTask({ ...task, id: 'x' })).toBeNull()
    expect(parseTask(null)).toBeNull()
  })
})

describe('background tool set', () => {
  it('has no input tools; children cannot spawn', () => {
    const names = backgroundToolDefs({ child: false }).map((t) => t.name)
    expect(names).toContain('spawn_task')
    expect(names).not.toContain('act')
    expect(names).not.toContain('observe')
    expect(backgroundToolDefs({ child: true }).map((t) => t.name)).not.toContain('spawn_task')
  })
})

describe('background first turn', () => {
  it('preloads a skill when its instructions are known, else points at use_skill', async () => {
    const { backgroundTurn } = await import('../../src/main/agent-mode/background/prompts')
    const at = new Date(0)
    expect(
      backgroundTurn('tidy downloads', at, { name: 'clean', text: '<skill>do x</skill>' })
    ).toContain('Follow these skill instructions for the task:\n<skill>do x</skill>')
    expect(backgroundTurn('tidy downloads', at, { name: 'clean' })).toContain('use_skill "clean"')
    expect(backgroundTurn('tidy downloads', at)).toMatch(/<task>tidy downloads<\/task>$/)
  })
})
