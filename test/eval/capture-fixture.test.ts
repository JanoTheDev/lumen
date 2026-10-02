// The pure half of scripts/capture-fixture.mjs: no agent is started here.
import { describe, expect, it } from 'vitest'
import {
  appendLine,
  buildCase,
  buildMeta,
  caseIds,
  caseProblems,
  convertOcr,
  convertUia,
  findCandidates,
  fixtureName,
  frameFile,
  isTerminalProcess,
  parseArgs,
  parseRect,
  rectToImage,
  redactText,
  slug,
  toMonitorRelative
} from '../../scripts/capture-fixture-lib.mjs'

// A secondary 150% monitor left of the primary, like the agent reports it.
const monitor = {
  id: 0,
  device: '\\\\.\\DISPLAY2',
  rect: { x: -2880, y: 0, w: 2880, h: 1800 },
  workArea: { x: -2880, y: 0, w: 2880, h: 1740 },
  dpi: 144,
  scale: 1.5,
  primary: false
}

interface Node {
  id: string
  role: string
  name: string
  rect: { x: number; y: number; w: number; h: number }
  monitorId: number
  enabled: boolean
  patterns: string[]
  children?: Node[]
}

const node = (id: string, name: string, x: number, y: number, children?: Node[]): Node => ({
  id,
  role: 'button',
  name,
  rect: { x, y, w: 60, h: 30 },
  monitorId: 0,
  enabled: true,
  patterns: ['invoke'],
  ...(children ? { children } : {})
})

describe('capture fixture helpers', () => {
  it('names folders in kebab-case', () => {
    expect(slug('  Outlook (classic) ')).toBe('outlook-classic')
    expect(fixtureName('Gmail', 'Inbox View')).toBe('gmail/inbox-view')
    expect(() => fixtureName('gmail', '!!')).toThrow()
  })

  it('makes rects monitor-relative', () => {
    expect(toMonitorRelative({ x: -2800, y: 40, w: 10, h: 20 }, monitor)).toEqual({
      x: 80,
      y: 40,
      w: 10,
      h: 20
    })
  })

  it('masks emails, key-shaped tokens and card numbers but keeps demo addresses', () => {
    expect(redactText('From anna.berg@gmail.com')).toBe('From user@example.com')
    expect(redactText('jip@example.com')).toBe('jip@example.com')
    const key = ['sk', 'proj', 'A'.repeat(30)].join('-')
    expect(redactText(`key ${key} end`)).toBe('key [secret] end')
    const gh = ['ghp', 'b'.repeat(36)].join('_')
    expect(redactText(gh)).toBe('[secret]')
    const jwt = ['eyJ' + 'a'.repeat(12), 'b'.repeat(12), 'c'.repeat(12)].join('.')
    expect(redactText(jwt)).toBe('[secret]')
    expect(redactText('session ' + 'a1'.repeat(20))).toBe('session [secret]')
    expect(redactText('card 4111 1111 1111 1111 ok')).toBe('card [number] ok')
    expect(redactText('Inbox (12) - Compose')).toBe('Inbox (12) - Compose')
    expect(redactText('internationalization-settings')).toBe('internationalization-settings')
    expect(redactText('')).toBe('')
  })

  it('converts a UIA snapshot to monitor-relative, redacted nodes', () => {
    const snap = {
      snapshotId: 's1',
      root: {
        ...node('e0', 'Mail - anna@corp.io', -2880, 0, [node('e1', 'Send', -2800, 100)]),
        value: 'anna@corp.io'
      }
    }
    const out = convertUia(snap, monitor)
    expect(out.snapshotId).toBe('s1')
    expect(out.root.name).toBe('Mail - user@example.com')
    expect(out.root.value).toBe('user@example.com')
    expect(out.root.rect).toEqual({ x: 0, y: 0, w: 60, h: 30 })
    expect(out.root.children[0].rect).toEqual({ x: 80, y: 100, w: 60, h: 30 })
    expect(convertUia(snap, monitor, false).root.name).toBe('Mail - anna@corp.io')
    expect(convertUia(undefined, monitor)).toEqual({})
    expect(snap.root.rect.x).toBe(-2880)
  })

  it('keeps selection / toggle / expand state on UIA nodes', () => {
    const tab = { ...node('e1', 'notes.txt', -2800, 100), selected: true, expanded: false }
    const box = { ...node('e2', 'Header Row', -2700, 100), toggled: 'mixed' }
    const out = convertUia(
      { snapshotId: 's2', root: node('e0', 'W', -2880, 0, [tab, box]) },
      monitor
    )
    expect(out.root.children[0]).toMatchObject({ selected: true, expanded: false })
    expect(out.root.children[1].toggled).toBe('mixed')
    expect(out.root.selected).toBeUndefined()
  })

  it('converts OCR words and lines', () => {
    const ocr = {
      words: [
        { text: 'bob@corp.io', rect: { x: -2870, y: 5, w: 50, h: 10 }, conf: 1, lineIndex: 0 }
      ],
      lines: [{ text: 'to bob@corp.io', rect: { x: -2880, y: 5, w: 70, h: 10 } }]
    }
    const out = convertOcr(ocr, monitor)
    expect(out.words[0]).toEqual({
      text: 'user@example.com',
      rect: { x: 10, y: 5, w: 50, h: 10 },
      conf: 1,
      lineIndex: 0
    })
    expect(out.lines[0].text).toBe('to user@example.com')
    expect(convertOcr(undefined, monitor)).toEqual({ words: [], lines: [] })
  })

  it('decodes frame data', () => {
    const f = frameFile({ mime: 'image/jpeg', data: Buffer.from('abc').toString('base64') })
    expect(f.ext).toBe('jpg')
    expect(f.buffer.toString()).toBe('abc')
    expect(frameFile({ mime: 'image/png', data: '' }).ext).toBe('png')
  })

  it('builds meta.json like the runner reads it', () => {
    const meta = buildMeta({
      app: 'Gmail',
      full: { monitor, width: 2880, height: 1800 },
      small: { monitor, width: 1280, height: 800 },
      window: {
        title: 'Inbox - anna@corp.io',
        process: 'chrome.exe',
        rect: { x: -2880, y: 0, w: 2880, h: 1740 }
      },
      capturedAt: '2026-10-01',
      extra: { theme: 'dark', appVersion: undefined, locale: 'en-US' }
    })
    expect(meta).toEqual({
      app: 'gmail',
      capturedAt: '2026-10-01',
      monitor: { id: 0, x: -2880, y: 0, w: 2880, h: 1800, scaleFactor: 1.5, primary: false },
      frame: { w: 2880, h: 1800, downscaled: { w: 1280, h: 800 } },
      window: {
        title: 'Inbox - user@example.com',
        process: 'chrome.exe',
        rect: { x: 0, y: 0, w: 2880, h: 1740 }
      },
      theme: 'dark',
      locale: 'en-US'
    })
    const same = buildMeta({
      app: 'x',
      full: { monitor, width: 1000, height: 600 },
      small: { monitor, width: 1000, height: 600 },
      capturedAt: 'd'
    })
    expect(same.frame).toEqual({ w: 1000, h: 600 })
    expect(same.window).toBeUndefined()
  })

  it('lists UIA candidates for a request', () => {
    const root = node('e0', 'Gmail', 0, 0, [
      node('e1', 'Compose', 10, 10),
      node('e2', 'Compose new message settings', 10, 50),
      node('e3', 'Inbox', 10, 90),
      { ...node('e4', 'Compose', 0, 0), rect: { x: 0, y: 0, w: 0, h: 0 } }
    ])
    expect(findCandidates(root, 'click the compose button').map((c) => c.id)).toEqual(['e1', 'e2'])
    expect(findCandidates(root, 'click the')).toEqual([])
  })

  it('builds a complete case from picked ids or a typed rect', () => {
    const root = node('e0', 'Gmail', 0, 0, [node('e1', 'Compose', 10, 10)])
    const meta = { frame: { w: 2880, h: 1800, downscaled: { w: 1280, h: 800 } } }
    const byId = buildCase({
      fixture: 'gmail/inbox',
      meta,
      uiaRoot: root,
      query: 'Compose a mail',
      expectIds: ['e1']
    })
    expect(byId).toEqual({
      id: 'gmail-inbox-compose-mail',
      fixture: 'gmail/inbox',
      query: 'Compose a mail',
      intent: 'click',
      modelTarget: { kind: 'element', id: 'e1' },
      expected: { elementIds: ['e1'], rects: [{ x: 10, y: 10, w: 60, h: 30 }] },
      category: 'text-label',
      uiaQuality: 'good',
      difficulty: 1
    })
    expect(caseProblems(byId)).toEqual([])
    expect(caseProblems(byId, ['gmail-inbox-compose-mail'])[0]).toMatch(/already/)

    const byRect = buildCase({
      fixture: 'gmail/inbox',
      meta,
      uiaRoot: undefined,
      query: 'the red dot',
      rects: [parseRect('900,450,90,45')],
      category: 'canvas',
      id: 'Red Dot'
    })
    expect(byRect.id).toBe('red-dot')
    expect(byRect.uiaQuality).toBe('none')
    expect(byRect.modelTarget).toEqual(rectToImage({ x: 900, y: 450, w: 90, h: 45 }, meta))
    expect(byRect.modelTarget).toEqual({ kind: 'rect', x: 400, y: 200, w: 40, h: 20, frame: '1' })

    const none = buildCase({ fixture: 'a/b', meta, query: 'the logout button', none: true })
    expect(none.expected).toEqual({ none: true })
    expect(none.modelTarget).toBeNull()
    expect(caseProblems(none)).toEqual([])

    const empty = buildCase({ fixture: 'a/b', meta, query: '' })
    expect(caseProblems(empty)).toEqual(
      expect.arrayContaining(['query is empty (--query)', expect.stringMatching(/no expected/)])
    )
    expect(() =>
      buildCase({ fixture: 'a/b', meta, uiaRoot: root, query: 'q', expectIds: ['e9'] })
    ).toThrow(/e9/)
    expect(() => parseRect('1,2,0,4')).toThrow()
  })

  it('appends to cases.jsonl on its own line', () => {
    const text = '{"id":"a"}\n{"id":"b"}'
    expect(caseIds(text)).toEqual(['a', 'b'])
    expect(appendLine(text, { id: 'c' })).toBe('\n{"id":"c"}\n')
    expect(appendLine(text + '\n', { id: 'c' })).toBe('{"id":"c"}\n')
    expect(appendLine('', { id: 'c' })).toBe('{"id":"c"}\n')
  })

  it('parses argv and spots terminals', () => {
    expect(
      parseArgs(['case', '--fixture', 'gmail/inbox', '--append', '--no-redact', '--rect=1,2,3,4'])
    ).toEqual({ _: ['case'], fixture: 'gmail/inbox', append: true, redact: false, rect: '1,2,3,4' })
    expect(isTerminalProcess('WindowsTerminal.exe')).toBe(true)
    expect(isTerminalProcess('code.exe')).toBe(false)
  })
})
