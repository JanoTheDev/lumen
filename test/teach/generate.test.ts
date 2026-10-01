import { describe, expect, it } from 'vitest'
import type { ElementNode } from '../../src/shared/types'
import {
  appIdFor,
  generateLesson,
  genLessonSchema,
  toLesson,
  type GenLesson
} from '../../src/main/teach/generate'
import { lessonTurn } from '../../src/main/ai/prompts/lesson'
import { anthropicJsonSchema, openaiStrictSchema } from '../../src/main/ai/providers/structured'

type GenStep = GenLesson['steps'][number]

const T = { kind: 'none', elementId: '', name: '', role: '', text: '', region: '', shortcut: '' }
const C = {
  kind: 'manual',
  event: 'invoked',
  name: '',
  role: '',
  value: '',
  titleRegex: '',
  question: ''
}

const step = (over: {
  say: string
  target?: Partial<GenStep['target']>
  check?: Partial<GenStep['check']>
  hints?: string[]
  why?: string
}): GenStep => ({
  say: over.say,
  why: over.why ?? 'It matters.',
  hints: over.hints ?? ['Look on the left.'],
  target: { ...T, ...over.target } as GenStep['target'],
  check: { ...C, ...over.check } as GenStep['check']
})

const node = (id: string, name: string, role: string): ElementNode => ({
  id,
  name,
  role,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  monitorId: 1,
  enabled: true,
  patterns: ['invoke']
})

const SCALING: GenLesson = {
  title: 'Change display scaling',
  minutes: 2,
  steps: [
    step({
      say: 'Click System.',
      target: { kind: 'element', elementId: 'e3', name: 'Sys', role: 'x' },
      check: { kind: 'uia-event', event: 'invoked', question: 'Is the System page open?' }
    }),
    step({
      say: 'Just click Display.',
      target: { kind: 'element', name: 'Display', role: 'listitem' },
      check: { kind: 'uia-event', event: 'selected', name: 'Display', question: '' }
    }),
    step({
      say: 'Pick 125% under Scale.',
      target: { kind: 'element', name: 'Scale', role: 'combobox' },
      check: {
        kind: 'uia-event',
        event: 'value',
        name: 'Scale',
        value: '125%',
        question: 'Does Scale show 125%?'
      }
    })
  ]
}

describe('toLesson', () => {
  const elements = new Map([['e3', node('e3', 'System', 'listitem')]])

  it('makes a C9 lesson with uia-event checks backed by vision', () => {
    const l = toLesson(SCALING, {
      appId: 'windows',
      question: 'how do I change scaling',
      elements
    })!
    expect(l.id).toBe('windows-gen-change-display-scaling')
    expect(l.app).toBe('windows')
    expect(l.steps).toHaveLength(3)
    // The element id resolves to the node's real name and role.
    expect(l.steps[0].target).toEqual({ element: { name: 'System', role: 'listitem' } })
    expect(l.steps[0].check).toEqual({
      type: 'anyOf',
      checks: [
        {
          type: 'uia-event',
          event: 'invoked',
          match: { name: 'System', role: 'listitem' }
        },
        { type: 'vision', prompt: 'Is the System page open?' }
      ]
    })
    // "just" is dropped from spoken text; an empty question derives one from say.
    expect(l.steps[1].say).toBe('Click Display.')
    expect(l.steps[1].check).toMatchObject({
      checks: [
        { event: 'selected' },
        { type: 'vision', prompt: expect.stringContaining('Display') }
      ]
    })
    expect(l.steps[2].check).toMatchObject({
      checks: [{ match: { name: 'Scale', value: '125%' } }, { type: 'vision' }]
    })
  })

  it('uses vision only when the app has no usable UIA', () => {
    const l = toLesson(SCALING, { appId: 'blender', question: 'q', uiaNone: true })!
    expect(l.steps.every((s) => s.check.type === 'vision')).toBe(true)
  })

  it('builds shortcut lessons with keypress checks (Blender extrude)', () => {
    const g: GenLesson = {
      title: 'Extrude a face',
      minutes: 3,
      steps: [
        step({
          say: 'Press Tab for edit mode.',
          target: { kind: 'shortcut', shortcut: 'Tab' },
          check: { kind: 'keypress', question: 'Is Blender in Edit Mode?' }
        }),
        step({
          say: 'Press 3 for face select.',
          target: { kind: 'shortcut', shortcut: '3' },
          check: { kind: 'vision', question: 'Is face select mode on?' }
        }),
        step({
          say: 'Press E and move the mouse.',
          target: { kind: 'shortcut', shortcut: 'E' },
          check: { kind: 'vision', question: 'Was a face extruded?' }
        })
      ]
    }
    const l = toLesson(g, { appId: 'blender', question: 'how do I extrude', uiaNone: true })!
    expect(l.steps.map((s) => s.target)).toEqual([
      { shortcut: 'Tab' },
      { shortcut: '3' },
      { shortcut: 'E' }
    ])
    expect(l.steps[0].check).toEqual({
      type: 'anyOf',
      checks: [
        { type: 'keypress', combo: 'Tab' },
        { type: 'vision', prompt: 'Is Blender in Edit Mode?' }
      ]
    })
    expect(l.steps[2].check).toEqual({ type: 'vision', prompt: 'Was a face extruded?' })
  })

  it('drops unknown regions, bad regexes and empty steps', () => {
    const g: GenLesson = {
      title: 'X',
      minutes: 0,
      steps: [
        step({ say: '  ' }),
        step({
          say: 'Look at the outliner.',
          target: { kind: 'region', region: 'nowhere' },
          check: { kind: 'window-title', titleRegex: '([', question: 'Is it there?' }
        }),
        step({ say: 'Open the outliner.', target: { kind: 'region', region: 'outliner' } })
      ]
    }
    const l = toLesson(g, {
      appId: 'blender',
      question: 'how do I see my objects',
      regions: { outliner: {} }
    })!
    expect(l.title).toBe('how do I see my objects')
    expect(l.minutes).toBe(1)
    expect(l.steps).toHaveLength(2)
    expect(l.steps[0].target).toBeNull()
    expect(l.steps[0].check).toEqual({ type: 'vision', prompt: 'Is it there?' })
    expect(l.steps[1].target).toEqual({ region: 'outliner' })
    expect(l.steps[1].check).toEqual({ type: 'manual' })
  })

  it('returns null when no step is usable', () => {
    expect(
      toLesson({ title: 'x', minutes: 1, steps: [] }, { appId: 'a', question: 'q' })
    ).toBeNull()
  })
})

describe('generateLesson', () => {
  it('sends the question, context and image, then converts the reply', async () => {
    let seen: { user: string; image?: unknown } | null = null
    const l = await generateLesson(
      {
        appId: 'windows',
        question: 'how do I change my display scaling',
        turn: {
          question: 'how do I change my display scaling',
          foreground: 'Settings (SystemSettings.exe)',
          app: 'Windows',
          elements: 'e3 listitem "System" @(0,0,10,10)',
          uiaQuality: 'good'
        },
        image: { data: 'img', mime: 'image/jpeg' }
      },
      async (req) => {
        seen = req
        return SCALING
      }
    )
    expect(l?.steps).toHaveLength(3)
    expect(seen!.user).toContain('<question>how do I change my display scaling</question>')
    expect(seen!.user).toContain('<elements>')
    expect(seen!.image).toEqual({ data: 'img', mime: 'image/jpeg' })
  })

  it('returns null when the model gives nothing', async () => {
    const l = await generateLesson(
      { appId: 'a', question: 'q', turn: { question: 'q', foreground: '' } },
      async () => null
    )
    expect(l).toBeNull()
  })
})

describe('generator plumbing', () => {
  it('the schema converts for both providers', () => {
    expect(() => anthropicJsonSchema(genLessonSchema)).not.toThrow()
    expect(JSON.stringify(openaiStrictSchema(genLessonSchema))).not.toContain('minLength')
  })

  it('lessonTurn leaves out empty blocks', () => {
    expect(lessonTurn({ question: 'q', foreground: 'Notepad' })).not.toContain('<elements>')
  })

  it('appIdFor uses the pack, else the process name', () => {
    expect(appIdFor({ id: 'blender' }, 'blender.exe')).toBe('blender')
    expect(appIdFor(null, 'C:\\Windows\\notepad.exe')).toBe('notepad')
    expect(appIdFor(null, undefined)).toBe('desktop')
  })
})
