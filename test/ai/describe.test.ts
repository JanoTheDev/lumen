import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/windows/highlight', () => ({ isVisible: () => false, hide: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import type { ElementNode } from '@shared/types'
import { describeScreen, explainTarget, type DescribeDeps } from '../../src/main/ai/describe'
import { setProvider } from '../../src/main/ai/providers'
import { PLAIN_STYLE_LINE } from '../../src/main/a11y/phrases'
import type {
  ChatChunk,
  CompleteResult,
  LlmProvider,
  StructuredRequest
} from '../../src/main/ai/providers/types'
import { windowOnlyContext, type QueryContext } from '../../src/main/query/context'

function node(
  id: string,
  role: string,
  name: string,
  x: number,
  extra: Partial<ElementNode> = {}
): ElementNode {
  return {
    id,
    role,
    name,
    rect: { x, y: 100, w: 80, h: 30 },
    monitorId: 0,
    enabled: true,
    patterns: ['invoke'],
    ...extra
  }
}

const GEOMETRY = { originX: 0, originY: 0, width: 1920, height: 1080, imgW: 1280, imgH: 720 }

function context(): QueryContext {
  return {
    ...windowOnlyContext({ title: 'Inbox - Gmail', rect: { x: 0, y: 0, w: 1920, h: 1080 } }),
    frames: [{ id: 'f1', label: '1', geometry: GEOMETRY, mime: 'image/jpeg', data: 'IMG' }],
    screenshot: 'IMG',
    uia: {
      snapshotId: 's',
      root: {
        ...node('e0', 'window', 'Inbox - Gmail', 0),
        rect: { x: 0, y: 0, w: 1920, h: 1080 },
        children: [
          node('e1', 'button', 'Compose', 20),
          node('e2', 'edit', 'Search mail', 300, { focused: true, value: 'invoices' }),
          node('e3', 'button', 'Send', 600, { enabled: false })
        ]
      }
    }
  }
}

const keyless: DescribeDeps = { capture: async () => context(), hasModel: () => false }
const withModel: DescribeDeps = { capture: async () => context(), hasModel: () => true }

describe('describeScreen', () => {
  const key = process.env.ANTHROPIC_API_KEY
  let seen: StructuredRequest<unknown>[] = []
  const answer = (data: unknown): LlmProvider => ({
    id: 'anthropic',
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ChatChunk> {
      throw new Error('not streamed')
    },
    complete: async <T>(req: StructuredRequest<T>): Promise<CompleteResult<T>> => {
      seen.push(req as StructuredRequest<unknown>)
      return {
        text: JSON.stringify(data),
        data: data as T,
        model: req.model,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
    },
    warmup: async () => {}
  })

  beforeEach(() => {
    seen = []
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    setProvider('anthropic', null)
    process.env.ANTHROPIC_API_KEY = key
    vi.restoreAllMocks()
  })

  it('works without a key from UIA alone', async () => {
    const d = await describeScreen({ detail: 'brief' }, keyless)
    expect(d.source).toBe('uia')
    expect(d.spoken).toBe(
      "You're in Inbox - Gmail. Focus is on Search mail edit, invoices. You can use: Compose button, Search mail edit."
    )
    expect(d.focused).toEqual({ role: 'edit', name: 'Search mail', value: 'invoices' })
  })

  it('asks the fast model with the element list and a low-detail image for brief', async () => {
    setProvider(
      'anthropic',
      answer({ spoken: 'Gmail inbox. You are in the search box.', actionable: ['Compose button'] })
    )
    const d = await describeScreen({ detail: 'brief', focus: 'selection' }, withModel)
    expect(d).toMatchObject({
      source: 'model',
      spoken: 'Gmail inbox. You are in the search box.',
      actionable: ['Compose button'],
      window: 'Inbox - Gmail'
    })
    const req = seen[0]
    expect(req.model).toBe('claude-haiku-4-5')
    expect(req.images).toEqual([{ base64: 'IMG', detail: 'low' }])
    expect(req.maxTokens).toBeLessThanOrEqual(300)
    const turn = req.messages[0].content
    expect(turn).toContain('focused: Search mail edit, invoices')
    expect(turn).toContain('e1 button "Compose"')
    expect(turn).toContain('focus: selection')
  })

  it('falls back to UIA when the model fails', async () => {
    setProvider('anthropic', {
      ...answer({}),
      complete: async () => Promise.reject(new Error('offline'))
    })
    const d = await describeScreen({ detail: 'full' }, withModel)
    expect(d.source).toBe('uia')
  })

  it('explainTarget sends the element facts and answers in speech', async () => {
    setProvider(
      'anthropic',
      answer({ spoken: 'Send button. It is disabled until you add a recipient.' })
    )
    const e = await explainTarget({ kind: 'element', id: 'e3' }, {}, withModel)
    expect(e).toMatchObject({
      source: 'model',
      element: { role: 'button', name: 'Send' },
      spoken: 'Send button. It is disabled until you add a recipient.'
    })
    expect(seen[0].messages[0].content).toContain('role button, name "Send", disabled')
    expect(await explainTarget({ kind: 'element', id: 'e3' }, {}, keyless)).toMatchObject({
      spoken: 'Send, a button, disabled.',
      source: 'uia'
    })
    expect((await explainTarget({ kind: 'element', id: 'nope' }, {}, keyless)).spoken).toBe(
      "I can't find that on the screen."
    )
  })

  it('explainTarget takes a physical pointer and captures every monitor when it is elsewhere', async () => {
    const calls: boolean[] = []
    const second = { originX: -2880, originY: 0, width: 2880, height: 1620, imgW: 1280, imgH: 720 }
    const deps: DescribeDeps = {
      hasModel: () => false,
      capture: async (_signal, allScreens) => {
        calls.push(!!allScreens)
        const ctx = context()
        if (!allScreens) return ctx
        return {
          ...ctx,
          frames: [
            ...ctx.frames,
            { id: 'f2', label: '2', geometry: second, mime: 'image/jpeg', data: 'IMG2' }
          ]
        }
      }
    }
    const on = await explainTarget({ kind: 'pointer', x: 50, y: 110 }, {}, deps)
    expect(calls).toEqual([false])
    expect(on.element).toMatchObject({ role: 'button', name: 'Compose' })

    calls.length = 0
    const off = await explainTarget({ kind: 'pointer', x: -1000, y: 500 }, {}, deps)
    expect(calls).toEqual([false, true])
    expect(off.spoken).not.toBe("I can't find that on the screen.")

    calls.length = 0
    await explainTarget({ kind: 'pointer', x: -1000, y: 5000 }, {}, deps)
    expect(calls).toEqual([false, true])
  })

  it('asks for the plain style in simple mode', async () => {
    setProvider('anthropic', answer({ spoken: 'Gmail. You can write a mail.', actionable: [] }))
    await describeScreen({ detail: 'brief' }, { ...withModel, style: () => 'plain' })
    await explainTarget({ kind: 'element', id: 'e1' }, {}, { ...withModel, style: () => 'plain' })
    await describeScreen({ detail: 'brief' }, withModel)
    expect(seen[0].messages[0].content).toContain(PLAIN_STYLE_LINE)
    expect(seen[1].messages[0].content).toContain(PLAIN_STYLE_LINE)
    expect(seen[2].messages[0].content).not.toContain(PLAIN_STYLE_LINE)
  })
})
