import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain Node script without type declarations
import {
  validateSkills,
  validateSchema,
  estimateTokens,
  LIMITS
} from '../scripts/validate-skills.mjs'

type Problem = { file: string; path: string; message: string }
type Result = { errors: Problem[]; packs: string[]; lessons: number }

const run = (dir?: string): Result => validateSkills(dir) as Result

describe('shipped skill packs', () => {
  const result = run()

  it('all validate against C8/C9 and the authoring rules', () => {
    const lines = result.errors.map((e) => `${e.file}: ${e.path}: ${e.message}`)
    expect(lines).toEqual([])
  })

  it('ship at least one lesson per pack', () => {
    expect(result.lessons).toBeGreaterThanOrEqual(result.packs.length)
  })
})

// --- fixture pack -----------------------------------------------------------

function lesson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-basics-01-first-steps',
    app: 'demo',
    title: 'First steps',
    level: 'beginner',
    minutes: 3,
    prereqs: [],
    appVersion: '>=1.0',
    steps: [
      {
        id: 'open-menu',
        say: 'Click File, at the top left of the window.',
        target: { element: { name: 'File', role: 'MenuItem' } },
        expect: {
          type: 'user-action',
          check: { type: 'uia-event', event: 'invoked', match: { name: 'File' } }
        },
        hints: ['File is the first word in the menu bar.', 'Press Alt then F to open it.'],
        why: 'Every command for saving and opening lives in the File menu.',
        doItForMe: { actions: [{ t: 'keys', combo: 'Alt+F' }] }
      },
      {
        id: 'pick-canvas',
        say: 'Click anywhere in the canvas.',
        target: { region: 'canvas' },
        expect: { type: 'user-action', check: 'vision', prompt: 'Is the canvas now selected?' },
        hints: ['The canvas is the large area in the middle.'],
        why: 'Shortcuts act on the panel under the mouse.'
      },
      {
        id: 'say-done',
        say: 'Say done when you are ready.',
        target: null,
        expect: {
          type: 'user-action',
          check: {
            type: 'anyOf',
            checks: [{ type: 'keypress', combo: 'Enter' }, { type: 'manual' }]
          }
        },
        hints: ['Press Enter if you prefer the keyboard.'],
        why: 'The lesson waits for you so you can go at your own pace.'
      }
    ],
    ...overrides
  }
}

function writePack(root: string, mutate?: (files: Record<string, unknown>) => void): void {
  const files: Record<string, unknown> = {
    'skill.json': {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      match: { process: ['demo.exe'] },
      uiaQuality: 'good',
      appVersion: '>=1.0',
      appVersionTested: '1.2.3',
      lastVerified: '2026-10-01'
    },
    'overview.md': '# Demo\n\nA demo app.\n',
    'shortcuts.md':
      '| Action | Shortcut | Mode/context |\n|---|---|---|\n| Save | Ctrl+S | Any |\n',
    'glossary.md': '- **Canvas** — the drawing area.\n',
    'SOURCES.md': '- https://example.com/docs\n',
    'regions.json': {
      window: 'main',
      layout: 'default',
      regions: { canvas: { x: 0.1, y: 0.1, w: 0.8, h: 0.8, desc: 'Drawing area' } }
    },
    'lessons/demo-basics-01-first-steps.lesson.json': lesson()
  }
  mutate?.(files)
  const pack = join(root, 'demo')
  mkdirSync(join(pack, 'lessons'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    writeFileSync(join(pack, name), text)
  }
}

describe('validator rules (fixture packs)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const messages = (): string[] => run(root).errors.map((e) => `${e.path}: ${e.message}`)
  const LESSON = 'lessons/demo-basics-01-first-steps.lesson.json'

  it('accepts a well-formed pack', () => {
    writePack(root)
    expect(run(root)).toMatchObject({ errors: [], packs: ['demo'], lessons: 1 })
  })

  it('reports missing required files', () => {
    writePack(root, (f) => {
      f['glossary.md'] = undefined
      f['SOURCES.md'] = undefined
    })
    const files = run(root).errors.map((e) => e.file.replace(/\\/g, '/'))
    expect(files.some((f) => f.endsWith('demo/glossary.md'))).toBe(true)
    expect(files.some((f) => f.endsWith('demo/SOURCES.md'))).toBe(true)
  })

  it('checks skill.json fields and folder name', () => {
    writePack(root, (f) => {
      f['skill.json'] = { id: 'other', name: 'X', version: '1', match: {}, uiaQuality: 'great' }
    })
    const m = messages()
    expect(m).toContain('$.id: must equal folder name "demo"')
    expect(m).toContain('$.version: must match /^\\d+\\.\\d+\\.\\d+$/')
    expect(m.some((x) => x.startsWith('$.uiaQuality: must be one of'))).toBe(true)
    expect(m).toContain('$: missing required property "lastVerified"')
    expect(m).toContain('$.match: needs at least one process, title or url rule')
  })

  it('caps overview.md at the token budget', () => {
    writePack(root, (f) => {
      f['overview.md'] = 'word '.repeat(LIMITS.overviewTokens * 2)
    })
    expect(messages().some((m) => m.includes(`max ${LIMITS.overviewTokens}`))).toBe(true)
  })

  it('checks region geometry and region references', () => {
    writePack(root, (f) => {
      f['regions.json'] = {
        window: 'main',
        layout: 'default',
        regions: { canvas: { x: 0.5, y: 0.1, w: 0.8, h: 0.8, desc: 'Too wide' } }
      }
      const l = lesson()
      ;(l.steps as Record<string, unknown>[])[1].target = { region: 'nowhere' }
      f[LESSON] = l
    })
    const m = messages()
    expect(m).toContain('$.regions.canvas: x + w must be <= 1')
    expect(m).toContain('$.steps[1].target.region: unknown region "nowhere" (not in regions.json)')
  })

  it('checks lesson id, app, file name, step count and prereqs', () => {
    writePack(root, (f) => {
      f[LESSON] = lesson({
        id: 'demo-basics-02-other',
        app: 'nope',
        prereqs: ['demo-basics-99-missing'],
        steps: (lesson().steps as unknown[]).slice(0, 2)
      })
    })
    const m = messages()
    expect(m).toContain('$.id: file name must be demo-basics-02-other.lesson.json')
    expect(m).toContain('$.app: must be "demo" (the pack id)')
    expect(m).toContain('$.steps: must have at least 3 items (has 2)')
    expect(m).toContain('$.prereqs[0]: unknown lesson id "demo-basics-99-missing"')
  })

  it('rejects unknown target kinds, check types and action types', () => {
    writePack(root, (f) => {
      const l = lesson()
      const steps = l.steps as Record<string, unknown>[]
      steps[0].target = { pixel: [1, 2] }
      steps[1].expect = { type: 'user-action', check: { type: 'telepathy' } }
      steps[2].doItForMe = { actions: [{ t: 'exec', cmd: 'rm' }] }
      f[LESSON] = l
    })
    const m = messages()
    expect(m.some((x) => x.startsWith('$.steps[0].target: does not match'))).toBe(true)
    expect(m.some((x) => x.startsWith('$.steps[1].expect.check: does not match'))).toBe(true)
    expect(m.some((x) => x.startsWith('$.steps[2].doItForMe.actions[0]: does not match'))).toBe(
      true
    )
  })

  it('requires say, hints and why on every step', () => {
    writePack(root, (f) => {
      const l = lesson()
      const step = (l.steps as Record<string, unknown>[])[0]
      delete step.why
      step.hints = []
      f[LESSON] = l
    })
    const m = messages()
    expect(m).toContain('$.steps[0]: missing required property "why"')
    expect(m).toContain('$.steps[0].hints: must have at least 1 items (has 0)')
  })

  it('applies the ear lint to say and hints', () => {
    writePack(root, (f) => {
      const l = lesson()
      const steps = l.steps as Record<string, unknown>[]
      steps[0].say = 'Simply press Ctrl+S to save!'
      steps[1].say = 'Click at (640, 480) on the **canvas** now.'
      steps[2].say = Array.from({ length: 30 }, () => 'word').join(' ')
      steps[2].hints = [steps[2].say]
      f[LESSON] = l
    })
    const m = messages()
    expect(m).toContain('$.steps[0].say: say uses "simply"')
    expect(m).toContain('$.steps[0].say: say has an exclamation mark')
    expect(m).toContain(
      '$.steps[0].say: say writes a shortcut with "+"; spell it out ("Control Shift A")'
    )
    expect(m).toContain('$.steps[1].say: say mentions raw coordinates')
    expect(m).toContain('$.steps[1].say: say contains markdown')
    expect(m).toContain(`$.steps[2].say: say has 30 words, max ${LIMITS.sayWords}`)
    expect(m).toContain('$.steps[2].hints[0]: hint only repeats the step')
  })

  it('flags links, file paths and abbreviations in spoken lines', () => {
    writePack(root, (f) => {
      const l = lesson()
      const steps = l.steps as Record<string, unknown>[]
      steps[0].say = 'Open https://example.org in your browser.'
      steps[1].hints = ['Save it in C:\\Users\\you\\Pictures for now.']
      steps[2].why = 'Shapes, e.g. circles, start here.'
      f[LESSON] = l
    })
    const m = messages()
    expect(m).toContain('$.steps[0].say: say reads out a link or file path')
    expect(m).toContain('$.steps[1].hints[0]: hint reads out a link or file path')
    expect(m).toContain('$.steps[2].why: why uses an abbreviation; write it out')
  })

  it('needs a prompt for vision checks and valid regexes', () => {
    writePack(root, (f) => {
      const l = lesson()
      const steps = l.steps as Record<string, unknown>[]
      steps[1].expect = { type: 'user-action', check: 'vision' }
      steps[2].expect = { type: 'user-action', check: { type: 'window-title', regex: '(' } }
      f[LESSON] = l
    })
    const m = messages()
    expect(m).toContain('$.steps[1].expect.prompt: a vision check needs a specific yes/no prompt')
    expect(m).toContain('$.steps[2].expect.check: invalid regex "("')
  })

  it('flags duplicate lesson ids across files', () => {
    writePack(root, (f) => {
      f['lessons/demo-basics-01-first-steps-copy.lesson.json'] = lesson()
    })
    expect(messages().some((m) => m.startsWith('$.id: duplicate lesson id'))).toBe(true)
  })

  it('checks curriculum.json: app, known lessons, all listed once, prereq order', () => {
    const second = lesson({
      id: 'demo-basics-02-second',
      title: 'Second',
      prereqs: ['demo-basics-01-first-steps']
    })
    writePack(root, (f) => {
      f['lessons/demo-basics-02-second.lesson.json'] = second
      f['curriculum.json'] = {
        app: 'demo',
        units: [
          {
            id: 'basics',
            title: 'Basics',
            lessons: ['demo-basics-01-first-steps', 'demo-basics-02-second']
          }
        ]
      }
    })
    expect(run(root).errors).toEqual([])

    writePack(root, (f) => {
      f['lessons/demo-basics-02-second.lesson.json'] = second
      f['curriculum.json'] = {
        app: 'other',
        units: [
          { id: 'a', title: 'A', lessons: ['demo-basics-02-second', 'demo-nope'] },
          { id: 'a', title: 'A again', lessons: ['demo-basics-02-second'] }
        ]
      }
    })
    const m = messages()
    expect(m).toContain('$.app: must equal folder name "demo"')
    expect(m).toContain(
      '$.units[0].lessons[0]: "demo-basics-02-second" comes before its prereq "demo-basics-01-first-steps"'
    )
    expect(m).toContain('$.units[0].lessons[1]: unknown lesson id "demo-nope" in this pack')
    expect(m).toContain('$.units[1].id: duplicate unit id "a"')
    expect(m).toContain('$.units[1].lessons[0]: "demo-basics-02-second" is listed twice')
    expect(m).toContain('$.units: lesson "demo-basics-01-first-steps" is in no unit')
  })

  it('rejects a curriculum that breaks the schema', () => {
    writePack(root, (f) => {
      f['curriculum.json'] = { app: 'demo', units: [] }
    })
    expect(messages().some((m) => m.startsWith('$.units'))).toBe(true)
  })
})

describe('helpers', () => {
  it('estimates tokens as chars / 4', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('validateSchema resolves $ref and reports paths', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/n' } },
      $defs: { n: { type: 'integer', minimum: 1 } }
    }
    expect(validateSchema({ a: 0 }, schema)).toEqual([{ path: '$.a', message: 'must be >= 1' }])
  })
})
