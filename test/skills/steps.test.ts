import { describe, expect, it } from 'vitest'
import type { ElementNode, SkillManifest } from '@shared/types'
import { permissionsSchema } from '../../src/main/skills/manifest'
import {
  describeSkillStep,
  fillStepParams,
  findElement,
  parseStepsFile,
  stepActions,
  usedParams,
  type SkillStep
} from '../../src/main/skills/steps'

const node = (p: Partial<ElementNode> & { id: string; name: string }): ElementNode => ({
  role: 'button',
  rect: { x: 10, y: 20, w: 100, h: 30 },
  monitorId: 0,
  enabled: true,
  patterns: ['invoke'],
  ...p
})

const manifest = (params: SkillManifest['params'] = {}): SkillManifest => ({
  name: 'export-png',
  description: 'Export as PNG.',
  version: '1.0.0',
  apps: [],
  triggers: [],
  params,
  permissions: permissionsSchema.parse({ input: true }),
  context: 'foreground'
})

describe('steps.json', () => {
  it('parses a valid file and fills defaults', () => {
    const f = parseStepsFile(
      JSON.stringify({
        steps: [
          { do: 'invoke', target: { name: 'File', role: 'menuitem' } },
          { do: 'set_value', target: { automationId: 'fname' }, value: '{file}' },
          { do: 'keys', combo: 'ctrl+shift+e', expect: { kind: 'window_title', value: 'Export' } },
          { do: 'wait', for: { kind: 'element', value: 'Export' }, timeoutMs: 3000 },
          { do: 'launch_app', app: 'Blender' }
        ]
      })
    )
    expect(f.version).toBe(1)
    expect(f.steps).toHaveLength(5)
    expect(describeSkillStep(f.steps[4])).toBe('Start Blender')
    expect(stepActions(f.steps[4], null)).toEqual([])
  })

  it('rejects bad files with a readable reason', () => {
    expect(() => parseStepsFile('{')).toThrow(/not valid JSON/)
    expect(() => parseStepsFile(JSON.stringify({ steps: [] }))).toThrow(/steps/)
    expect(() => parseStepsFile(JSON.stringify({ steps: [{ do: 'invoke', target: {} }] }))).toThrow(
      /name or an automationId/
    )
    expect(() => parseStepsFile(JSON.stringify({ steps: [{ do: 'run', cmd: 'calc' }] }))).toThrow()
    expect(() =>
      parseStepsFile(JSON.stringify({ steps: [{ do: 'keys', combo: 'ctrl s; rm' }] }))
    ).toThrow()
  })

  it('fills placeholders, encodes them in URLs and lists missing ones', () => {
    const steps: SkillStep[] = [
      { do: 'navigate', url: 'https://example.com/search?q={term}' },
      { do: 'set_value', target: { name: 'Name' }, value: '{file}.png' }
    ]
    expect(usedParams(steps)).toEqual(['term', 'file'])
    const m = manifest({ term: { type: 'string' }, file: { type: 'string', default: 'out' } })
    const missing = fillStepParams(steps, m)
    expect(missing.missing).toEqual(['term'])
    expect(missing.steps).toEqual([])
    const ok = fillStepParams(steps, m, [{ name: 'term', value: 'a b&c' }])
    expect(ok.missing).toEqual([])
    expect(ok.steps[0]).toMatchObject({ url: 'https://example.com/search?q=a%20b%26c' })
    expect(ok.steps[1]).toMatchObject({ value: 'out.png' })
    // The original steps are left as they were.
    expect(steps[1]).toMatchObject({ value: '{file}.png' })
  })

  it('reports placeholders that are not declared', () => {
    const r = fillStepParams([{ do: 'type', value: '{nope}' }], manifest())
    expect(r.problems).toEqual(['{nope} is not a declared parameter'])
  })

  it('finds elements by automation id, then name and role', () => {
    const nodes = [
      node({ id: 'a', name: 'Export', role: 'menuitem', rect: { x: 0, y: 0, w: 0, h: 0 } }),
      node({ id: 'b', name: 'export', role: 'menuitem' }),
      node({ id: 'c', name: 'Export', role: 'button', automationId: 'exp' })
    ]
    expect(findElement(nodes, { automationId: 'exp' })?.id).toBe('c')
    expect(findElement(nodes, { name: 'Export', role: 'menuitem' })?.id).toBe('b')
    expect(findElement(nodes, { name: 'EXPORT', role: 'list' })?.id).toBe('b')
    expect(findElement(nodes, { name: 'Import' })).toBeNull()
    expect(findElement(nodes, { automationId: 'gone', name: 'Export', role: 'button' })?.id).toBe(
      'c'
    )
  })

  it('maps steps to executor actions', () => {
    const btn = node({ id: 'e1', name: 'OK' })
    expect(stepActions({ do: 'invoke', target: { name: 'OK' } }, btn)).toEqual([
      { type: 'uia_act', elementId: 'e1', action: 'invoke', description: 'OK' }
    ])
    const plain = node({ id: 'e2', name: 'Pane', patterns: [] })
    expect(stepActions({ do: 'invoke', target: { name: 'Pane' } }, plain)).toEqual([
      { type: 'input', steps: [{ t: 'click', button: 'left', x: 60, y: 35 }] }
    ])
    const field = node({ id: 'e3', name: 'Name', role: 'edit', patterns: ['value'] })
    expect(stepActions({ do: 'set_value', target: { name: 'Name' }, value: 'x' }, field)).toEqual([
      { type: 'uia_act', elementId: 'e3', action: 'set_value', value: 'x', description: 'Name' }
    ])
    expect(stepActions({ do: 'type', value: 'hi' }, null)).toEqual([{ type: 'type', text: 'hi' }])
    expect(stepActions({ do: 'keys', combo: 'Ctrl+S' }, null)).toEqual([
      { type: 'hotkey', keys: ['ctrl', 's'] }
    ])
    expect(stepActions({ do: 'double_click', target: { name: 'OK' } }, btn)[0]).toMatchObject({
      steps: [{ count: 2 }]
    })
  })

  it('describes steps in words', () => {
    expect(describeSkillStep({ do: 'invoke', target: { name: 'Export' } })).toBe('Click “Export”')
    expect(describeSkillStep({ do: 'keys', combo: 'ctrl+s', say: 'Save it' })).toBe('Save it')
  })
})
