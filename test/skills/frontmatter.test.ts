import { describe, expect, it } from 'vitest'
import { FrontmatterError, parseYaml, splitFrontmatter } from '../../src/main/skills/frontmatter'
import { parseSkillFile, SkillFileError } from '../../src/main/skills/manifest'

describe('parseYaml (subset)', () => {
  it('reads block maps, lists, flow collections and scalars', () => {
    const y = parseYaml(`name: export-for-youtube   # comment
description: "Export: the \\"timeline\\""
version: 1.0.0
count: 3
on: true
none: ~
apps: [resolve, blender]
triggers:
  - export for youtube
  - 'make a youtube version'
params: { format: { type: string, default: "1080p" } }
permissions:
  input: true
  files: { read: ["~/Videos"], write: [] }
`)
    expect(y).toEqual({
      name: 'export-for-youtube',
      description: 'Export: the "timeline"',
      version: '1.0.0',
      count: 3,
      on: true,
      none: null,
      apps: ['resolve', 'blender'],
      triggers: ['export for youtube', 'make a youtube version'],
      params: { format: { type: 'string', default: '1080p' } },
      permissions: { input: true, files: { read: ['~/Videos'], write: [] } }
    })
  })

  it('reads | and > block text and "key:" followed by a list at the same indent', () => {
    expect(parseYaml('a: |\n  one\n  two\nb: >-\n  x\n  y\nc:\n- 1\n- 2')).toEqual({
      a: 'one\ntwo\n',
      b: 'x y',
      c: [1, 2]
    })
  })

  it('reads flow collections spread over lines (as Prettier writes them)', () => {
    expect(
      parseYaml("a:\n  {\n    type: string,\n    enum: [x, 'y]'],\n  }\nb: [1,\n  2]")
    ).toEqual({
      a: { type: 'string', enum: ['x', 'y]'] },
      b: [1, 2]
    })
  })

  it('keeps # inside quotes and words', () => {
    expect(parseYaml('a: "x # y"\nb: c#d')).toEqual({ a: 'x # y', b: 'c#d' })
  })

  it.each([
    ['a: 1\na: 2', 'appears twice'],
    ['a:\n\t- x', 'tabs'],
    ['a: &x 1', 'anchors'],
    ['a: [1, 2', 'expected'],
    ['just text', 'expected "key: value"'],
    ['a:\n  - b: 1', 'maps inside lists'],
    ['a: 1\n   b: 2', 'indentation']
  ])('rejects %j', (src, msg) => {
    expect(() => parseYaml(src)).toThrow(FrontmatterError)
    expect(() => parseYaml(src)).toThrow(msg)
  })
})

describe('splitFrontmatter', () => {
  it('splits header and body, with CRLF and a BOM', () => {
    const r = splitFrontmatter('\uFEFF---\r\nname: x\r\n---\r\n\r\nBody here.\r\n')
    expect(r).toEqual({ data: { name: 'x' }, body: 'Body here.' })
  })

  it('needs both fences', () => {
    expect(() => splitFrontmatter('name: x')).toThrow('must start with')
    expect(() => splitFrontmatter('---\nname: x\n')).toThrow('closing')
  })
})

describe('parseSkillFile', () => {
  it('fills defaults', () => {
    const { manifest, body, warnings } = parseSkillFile(
      '---\nname: a-b\ndescription: Does a.\n---\nGo.'
    )
    expect(manifest).toEqual({
      name: 'a-b',
      description: 'Does a.',
      version: '1.0.0',
      apps: [],
      triggers: [],
      params: {},
      permissions: {
        input: false,
        network: [],
        files: { read: [], write: [] },
        connectors: [],
        profile: false,
        risky: false,
        screen: false
      },
      context: 'foreground'
    })
    expect(body).toBe('Go.')
    expect(warnings).toEqual([])
  })

  it('accepts the C10 v2 fields', () => {
    const { manifest } = parseSkillFile(`---
name: x
description: d
when_to_use: when asked
context: background
model: fast
tools: [use_skill, fetch_url]
permissions: { screen: true, network: ["https://*.example.com"] }
---
b`)
    expect(manifest).toMatchObject({
      when_to_use: 'when asked',
      context: 'background',
      model: 'fast',
      tools: ['use_skill', 'fetch_url'],
      permissions: { screen: true, network: ['https://*.example.com'] }
    })
  })

  it('rejects unknown permission keys', () => {
    expect(() =>
      parseSkillFile('---\nname: x\ndescription: d\npermissions:\n  inputs: true\n---\nb')
    ).toThrow(SkillFileError)
    expect(() =>
      parseSkillFile('---\nname: x\ndescription: d\npermissions:\n  files: { exec: [a] }\n---\nb')
    ).toThrow(SkillFileError)
  })

  it('rejects bad names, long descriptions and non-https network patterns', () => {
    expect(() => parseSkillFile('---\nname: Bad Name\ndescription: d\n---\nb')).toThrow('name')
    expect(() => parseSkillFile(`---\nname: x\ndescription: ${'a'.repeat(201)}\n---\nb`)).toThrow(
      'description'
    )
    expect(() =>
      parseSkillFile(
        '---\nname: x\ndescription: d\npermissions: { network: ["file:///c"] }\n---\nb'
      )
    ).toThrow('network')
  })

  it('warns about unknown top-level keys and long bodies', () => {
    const r = parseSkillFile(`---\nname: x\ndescription: d\nfoo: 1\n---\n${'word '.repeat(4000)}`)
    expect(r.warnings.join(' ')).toMatch(/unknown header keys ignored: foo/)
    expect(r.warnings.join(' ')).toMatch(/instructions are long/)
  })
})
