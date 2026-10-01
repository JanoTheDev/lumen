import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSubtitles, transcriptFromCues } from '../../src/main/teach/importers/subtitles'
import { parseRobots, robotsAllow } from '../../src/main/teach/importers/robots'
import {
  fetchPage,
  htmlToArticle,
  isPrivateHost,
  type FetchLike
} from '../../src/main/teach/importers/web'
import { toTutorialLesson, type TutorialReply } from '../../src/main/teach/importers/tutorial'
import {
  importTutorial,
  matchImportCommand,
  YOUTUBE_MESSAGE,
  type ImportDeps
} from '../../src/main/teach/importers'
import { createRecorder, type RecordingDeps } from '../../src/main/teach/recording'
import type { Lesson } from '../../src/main/teach/lesson'

describe('subtitles', () => {
  const SRT = `1
00:00:01,000 --> 00:00:04,000
Hi, today we model a mug.

2
00:00:04,000 --> 00:00:40,500
Press <b>Shift+A</b> and add a cylinder.

3
00:00:41,000 --> 00:00:44,000
Then scale it.`

  it('parses SRT and VTT cues', () => {
    expect(parseSubtitles(SRT)).toHaveLength(3)
    expect(parseSubtitles(SRT)[1]).toEqual({
      start: 4,
      end: 40.5,
      text: 'Press Shift+A and add a cylinder.'
    })
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000 align:start\n<c>Hello</c> there\n'
    expect(parseSubtitles(vtt)).toEqual([{ start: 1, end: 2, text: 'Hello there' }])
  })

  it('makes a timed transcript and drops rolling repeats', () => {
    const t = transcriptFromCues([
      { start: 0, end: 2, text: 'open the' },
      { start: 2, end: 4, text: 'open the edit menu' },
      { start: 4, end: 40, text: 'now pick preferences' }
    ])
    expect(t).toBe('[0:00] open the edit menu now pick preferences')
  })
})

describe('robots', () => {
  const rules = parseRobots(
    `User-agent: *\nDisallow: /private\nAllow: /private/ok$\n\nUser-agent: BadBot\nDisallow: /\n`
  )
  it('longest match wins, allow wins ties, $ anchors', () => {
    expect(robotsAllow(rules, '/blog/post')).toBe(true)
    expect(robotsAllow(rules, '/private/x')).toBe(false)
    expect(robotsAllow(rules, '/private/ok')).toBe(true)
    expect(robotsAllow(rules, '/private/ok/more')).toBe(false)
  })
  it('uses the Lumen group when there is one', () => {
    const r = parseRobots('User-agent: *\nDisallow:\n\nUser-agent: Lumen\nDisallow: /\n')
    expect(robotsAllow(r, '/a')).toBe(false)
    expect(robotsAllow(parseRobots('User-agent: *\nDisallow: /*.pdf$'), '/a.pdf')).toBe(false)
  })
})

describe('web', () => {
  it('private hosts', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.4',
      '[::1]',
      'nas',
      'printer.local'
    ])
      expect(isPrivateHost(h)).toBe(true)
    expect(isPrivateHost('blender.org')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })

  it('htmlToArticle keeps the article text, headings, lists and alt text', () => {
    const html = `<html><head><title>How to &amp; why</title><script>evil()</script></head>
      <body><nav>Menu</nav><article><h2>Step one</h2><p>Press <kbd>Ctrl</kbd>+<kbd>S</kbd>.</p>
      <ul><li>First</li><li>Second</li></ul><img src="a.png" alt="The save dialog"></article>
      <footer>Copyright</footer></body></html>`
    const a = htmlToArticle(html)
    expect(a.title).toBe('How to & why')
    expect(a.text).toContain('## Step one')
    expect(a.text).toContain('Press `Ctrl`+`S`.')
    expect(a.text).toContain('- First')
    expect(a.text).toContain('[image: The save dialog]')
    expect(a.text).not.toMatch(/Menu|Copyright|evil/)
  })

  const page = (status: number, body = '', headers: Record<string, string> = {}): Response =>
    new Response(status >= 300 && status < 400 ? null : body, {
      status,
      headers: { 'content-type': 'text/html', ...headers }
    })

  it('respects robots.txt', async () => {
    const fetch: FetchLike = async (url) =>
      url.endsWith('/robots.txt') ? page(200, 'User-agent: *\nDisallow: /') : page(200, '<p>x</p>')
    await expect(fetchPage('https://site.test/a', fetch)).rejects.toThrow(/robots/)
  })

  it('follows https redirects, refuses http and private ones', async () => {
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      if (url.endsWith('/robots.txt')) return page(404)
      if (url === 'https://a.test/x') return page(301, '', { location: 'https://b.test/y' })
      if (url === 'https://b.test/y') return page(200, '<p>ok</p>')
      if (url === 'https://c.test/') return page(302, '', { location: 'http://c.test/' })
      return page(302, '', { location: 'https://127.0.0.1/' })
    }
    expect(await fetchPage('https://a.test/x', fetch)).toEqual({
      url: 'https://b.test/y',
      html: '<p>ok</p>'
    })
    expect(calls).toContain('https://b.test/robots.txt')
    await expect(fetchPage('https://c.test/', fetch)).rejects.toThrow(/https/)
    await expect(fetchPage('https://d.test/', fetch)).rejects.toThrow(/private/)
    await expect(fetchPage('http://a.test/', fetch)).rejects.toThrow(/https/)
  })

  it('an unreachable robots.txt means no', async () => {
    const fetch: FetchLike = async (url) =>
      url.endsWith('/robots.txt') ? page(503) : page(200, '<p>x</p>')
    await expect(fetchPage('https://site.test/a', fetch)).rejects.toThrow(/robots/)
  })
})

const REPLY: TutorialReply = {
  title: 'Model a mug',
  minutes: 10,
  app: 'Blender',
  tutorialVersion: '2.8',
  versionNotes: [{ step: 1, note: 'In Blender 4 the Add menu has a search box at the top.' }],
  steps: [
    {
      say: 'Press Shift A and pick Cylinder.',
      why: 'The cylinder is the body.',
      hints: ['Shift A opens the Add menu.'],
      target: {
        kind: 'shortcut',
        elementId: '',
        name: '',
        role: '',
        text: '',
        region: '',
        shortcut: 'Shift+A'
      },
      check: {
        kind: 'vision',
        event: 'invoked',
        name: '',
        role: '',
        value: '',
        titleRegex: '',
        question: 'Is a cylinder in the scene?'
      }
    }
  ]
}

describe('tutorial lesson', () => {
  it('flags version drift and keeps the notes as hints', () => {
    const t = toTutorialLesson(REPLY, {
      appId: 'blender',
      appName: 'Blender',
      url: 'https://x.test/a'
    })!
    expect(t.lesson.appVersion).toBe('2.8')
    expect(t.lesson.id).toMatch(/^blender-tut-/)
    expect(t.lesson.tags).toEqual(['tutorial'])
    expect(t.lesson.steps[0].hints[0]).toMatch(/^In Blender 4/)
    expect(t.lesson.summary).toBe('From a tutorial for Blender 2.8 (https://x.test/a).')
    expect(t.drift).toMatch(/^This tutorial shows Blender 2\.8\. One step may look different/)
  })

  it('voice command', () => {
    expect(matchImportCommand('Make a lesson from the clipboard.')).toBe(true)
    expect(matchImportCommand('turn this tutorial into a lesson')).toBe(true)
    expect(matchImportCommand('make a lesson')).toBe(false)
  })
})

describe('importTutorial', () => {
  function deps(over: Partial<ImportDeps> = {}): ImportDeps & { offered: Lesson[] } {
    const offered: Lesson[] = []
    return {
      offered,
      fetch: async () => {
        throw new Error('no network in tests')
      },
      app: (id) => (id === 'blender' ? { id, name: 'Blender', regions: { viewport: {} } } : null),
      appByName: (n) => (/blender/i.test(n) ? { id: 'blender', name: 'Blender' } : null),
      complete: vi.fn(async () => REPLY),
      offer: (l) => {
        offered.push(l)
        return { ok: true }
      },
      readingLevel: () => '',
      log: () => {},
      ...over
    }
  }
  const LONG = 'In this video we model a coffee mug. '.repeat(10)

  it('a pasted transcript becomes a draft for the app the model names', async () => {
    const d = deps()
    const r = await importTutorial({ kind: 'text', text: LONG }, {}, d)
    expect(r).toMatchObject({ ok: true, appName: 'Blender', steps: 1 })
    expect(d.offered[0].app).toBe('blender')
    const user = (d.complete as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(user).toContain('<tutorial>')
    expect(user).toContain('App: name it from the tutorial.')
  })

  it('a picked app sends its regions', async () => {
    const d = deps()
    await importTutorial({ kind: 'text', text: LONG }, { appId: 'blender' }, d)
    const user = (d.complete as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(user).toContain('Regions: viewport')
  })

  it('never fetches YouTube, and needs enough text', async () => {
    const d = deps({ fetch: vi.fn() })
    expect(
      await importTutorial({ kind: 'url', url: 'https://www.youtube.com/watch?v=abc' }, {}, d)
    ).toEqual({ ok: false, error: YOUTUBE_MESSAGE })
    expect(await importTutorial({ kind: 'text', text: 'https://youtu.be/abc' }, {}, d)).toEqual({
      ok: false,
      error: YOUTUBE_MESSAGE
    })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(await importTutorial({ kind: 'text', text: 'too short' }, {}, d)).toMatchObject({
      ok: false
    })
  })
})

describe('recorder.offerDraft', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('an imported lesson becomes the draft under review', () => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-import-'))
    const said: string[] = []
    const d: RecordingDeps = {
      now: () => 1,
      foreground: async () => null,
      subscribe: () => () => {},
      capture: async () => null,
      draftText: async () => null,
      hotkey: () => undefined,
      showState: () => {},
      showLine: () => {},
      say: (t) => said.push(t),
      lessonsDir: () => join(dir, 'lessons'),
      draftFile: () => join(dir, 'draft.lesson.json'),
      reload: () => {},
      play: () => true,
      lessonRunning: () => false,
      appName: (id) => id,
      log: () => {},
      handled: 'H'
    }
    const rec = createRecorder(d)
    const t = toTutorialLesson(REPLY, { appId: 'blender', appName: 'Blender' })!
    expect(rec.offerDraft(t.lesson, t.drift)).toEqual({ ok: true })
    expect(rec.status()).toMatchObject({ phase: 'draft', draft: { title: 'Model a mug' } })
    expect(said[0]).toMatch(
      /^Draft ready: “Model a mug”, 1 step\..*This tutorial shows Blender 2\.8/
    )
    expect(rec.intercept('read it back')).toBe('H')
    const saved = rec.save()
    expect('id' in saved && saved.id).toMatch(/^blender-model-a-mug/)
  })
})
