import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { frameGeometryOf } from '../../src/main/actions/coords'
import type { QueryContext } from '../../src/main/query/context'
import type { GenLesson } from '../../src/main/teach/generate'
import type { Lesson } from '../../src/main/teach/lesson'
import { makeShowMeHow } from '../../src/main/teach/show-me'

const GEN: GenLesson = {
  title: 'Open Notepad settings',
  minutes: 1,
  steps: [
    {
      say: 'Click the gear button.',
      why: 'Settings live there.',
      hints: ['Top right.'],
      target: {
        kind: 'element',
        elementId: 'e1',
        name: '',
        role: '',
        text: '',
        region: '',
        shortcut: ''
      },
      check: {
        kind: 'uia-event',
        event: 'invoked',
        name: '',
        role: '',
        value: '',
        titleRegex: '',
        question: 'Is the settings page open?'
      }
    }
  ]
}

function ctx(): QueryContext {
  const geometry = frameGeometryOf({ width: 100, height: 100, mime: 'image/jpeg', data: 'x' })
  return {
    frames: [{ id: 'f1', label: '1', geometry, mime: 'image/jpeg', data: 'img' }],
    foreground: { title: 'Untitled - Notepad', process: 'notepad.exe' },
    uia: {
      root: {
        id: 'root',
        role: 'window',
        name: 'Notepad',
        rect: { x: 0, y: 0, w: 100, h: 100 },
        monitorId: 1,
        enabled: true,
        patterns: [],
        children: [
          {
            id: 'e1',
            role: 'button',
            name: 'Settings',
            rect: { x: 80, y: 0, w: 20, h: 20 },
            monitorId: 1,
            enabled: true,
            patterns: ['invoke']
          }
        ]
      }
    } as QueryContext['uia'],
    ocr: async () => null,
    activeWindow: 'Untitled - Notepad',
    screenshot: 'img',
    at: 0
  }
}

describe('makeShowMeHow', () => {
  it('generates a lesson from the turn context and starts it', async () => {
    const started: Lesson[] = []
    let user = ''
    const run = makeShowMeHow({
      registry: () => null,
      start: (l) => started.push(l),
      complete: async (req) => {
        user = req.user
        return GEN
      }
    })
    const reply = await run('how do I open settings', ctx(), new AbortController().signal)
    expect(reply).toMatchObject({ mode: 'answer', dictated: true })
    expect(started).toHaveLength(1)
    expect(started[0].app).toBe('notepad')
    expect(started[0].steps[0].target).toEqual({ element: { name: 'Settings', role: 'button' } })
    expect(user).toContain('e1 button "Settings"')
  })

  it('returns null (guide fallback) when nothing usable comes back or the turn was cancelled', async () => {
    const start = vi.fn()
    const none = makeShowMeHow({ registry: () => null, start, complete: async () => null })
    expect(await none('q', ctx(), new AbortController().signal)).toBeNull()
    const ac = new AbortController()
    const cancelled = makeShowMeHow({
      registry: () => null,
      start,
      complete: async () => {
        ac.abort()
        return GEN
      }
    })
    expect(await cancelled('q', ctx(), ac.signal)).toBeNull()
    expect(start).not.toHaveBeenCalled()
  })
})
