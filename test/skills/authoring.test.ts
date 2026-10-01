import { describe, expect, it } from 'vitest'
import {
  actionSteps,
  draftFiles,
  draftFromText,
  draftFromVoice,
  freeName,
  matchCreateIntent,
  matchDraftCommand,
  matchWhenISay,
  paramName,
  readBack,
  renderSkillMd,
  skeletonToSteps,
  slugName,
  traceNetwork,
  traceToSteps,
  type AgentRunTrace
} from '../../src/main/skills/authoring'
import { parseSkillFile } from '../../src/main/skills/manifest'
import { parseStepsFile } from '../../src/main/skills/steps'

const RUN: AgentRunTrace = {
  prompt: 'email the report to anna',
  summary: 'Drafted the email.',
  at: 0,
  steps: [
    { tool: 'act', op: 'invoke', element: { name: 'New mail', role: 'button' } },
    { tool: 'act', op: 'type', element: { name: 'To', role: 'edit' }, value: 'anna@example.com' },
    { tool: 'keys', combo: 'Ctrl+Enter' },
    { tool: 'navigate', url: 'https://mail.example.com/search?q=anna%40example.com' },
    { tool: 'wait_for', wait: { kind: 'element', value: 'Sent' }, timeoutMs: 40_000 }
  ]
}

describe('save that as a skill (T09)', () => {
  it('turns the run into steps with params as placeholders', () => {
    const steps = traceToSteps(RUN, [{ name: 'recipient', value: 'anna@example.com' }])!
    expect(steps).toEqual([
      { do: 'invoke', target: { name: 'New mail', role: 'button' } },
      { do: 'type', target: { name: 'To', role: 'edit' }, value: '{recipient}' },
      { do: 'keys', combo: 'ctrl+enter' },
      { do: 'navigate', url: 'https://mail.example.com/search?q={recipient}' },
      { do: 'wait', for: { kind: 'element', value: 'Sent' }, timeoutMs: 15_000 }
    ])
    expect(traceNetwork(RUN)).toEqual(['https://mail.example.com'])
  })

  it('has no steps when a step needs the model to find its target', () => {
    expect(
      traceToSteps({ ...RUN, steps: [{ tool: 'act', op: 'click', positional: true }] })
    ).toBeNull()
    expect(traceToSteps({ ...RUN, steps: [{ tool: 'launch_app', app: 'Outlook' }] })).toBeNull()
    expect(traceToSteps({ ...RUN, steps: [{ tool: 'act', op: 'scroll' }] })).toBeNull()
  })

  it('builds a draft from the model words, with fallbacks', () => {
    const draft = draftFromText(
      {
        name: 'Mail The Report!',
        description: 'Emails the weekly report.',
        triggers: ['Send the report.'],
        instructions: '1. Open a new mail to {recipient}.',
        params: [
          { name: 'recipient', description: 'who gets it', value: 'anna@example.com' },
          { name: 'Bad Name!', description: '', value: '' }
        ]
      },
      {
        fallbackName: 'x',
        fallbackDescription: 'y',
        fallbackInstructions: 'z',
        permissions: { input: true, network: [] },
        steps: traceToSteps(RUN),
        source: 'agent-run'
      }
    )
    expect(draft.name).toBe('mail-the-report')
    expect(draft.triggers).toEqual(['send the report'])
    expect(draft.params.map((p) => p.name)).toEqual(['recipient', 'bad_name_'])
    expect(draft.steps?.steps[1]).toMatchObject({ value: '{recipient}' })
    const fallback = draftFromText(null, {
      fallbackName: 'Email the report',
      fallbackDescription: 'Drafted it.',
      fallbackInstructions: 'Do it.',
      permissions: { input: true, network: [] },
      source: 'agent-run'
    })
    expect(fallback).toMatchObject({ name: 'email-the-report', instructions: 'Do it.' })
    expect(fallback.steps).toBeUndefined()
  })

  it('writes a SKILL.md and steps.json that load', () => {
    const draft = draftFromText(
      {
        name: 'mail-report',
        description: 'Says "hi": and more',
        triggers: ['mail the report'],
        instructions: '1. Do it.',
        params: [{ name: 'recipient', description: 'who: "gets" it', value: 'anna@example.com' }]
      },
      {
        fallbackName: '',
        fallbackDescription: '',
        fallbackInstructions: '',
        permissions: { input: true, network: ['https://mail.example.com'] },
        steps: traceToSteps(RUN),
        source: 'agent-run'
      }
    )
    const files = draftFiles(draft)
    const parsed = parseSkillFile(files.skillMd)
    expect(parsed.manifest).toMatchObject({
      name: 'mail-report',
      description: 'Says "hi": and more',
      triggers: ['mail the report'],
      params: { recipient: { type: 'string', description: 'who: "gets" it' } },
      permissions: { input: true, network: ['https://mail.example.com'] }
    })
    expect(parsed.body).toBe('1. Do it.')
    expect(parseStepsFile(files.stepsJson!).steps).toHaveLength(5)
    expect(readBack(draft)).toMatch(/5 recorded steps .* asks for recipient/)
  })
})

describe('create by voice (T10)', () => {
  it('parses "when I say X, do Y"', () => {
    expect(matchWhenISay('When I say morning, open my mail and then read today’s events.')).toEqual(
      {
        phrase: 'morning',
        action: 'open my mail and then read today’s events'
      }
    )
    expect(matchWhenISay('when i say "lights out" you should lock the screen')).toEqual({
      phrase: 'lights out',
      action: 'lock the screen'
    })
    expect(matchWhenISay('create a skill: whenever I say tidy up, then close all windows')).toEqual(
      {
        phrase: 'tidy up',
        action: 'close all windows'
      }
    )
    expect(matchWhenISay('when I say')).toBeNull()
    expect(matchWhenISay('what do I say to my boss')).toBeNull()
  })

  it('drafts a skill with the phrase as trigger', () => {
    const d = draftFromVoice('morning', 'open my mail and then read today’s events')
    expect(d).toMatchObject({ name: 'morning', triggers: ['morning'], source: 'voice' })
    expect(d.instructions).toMatch(/1\. Open my mail\.\n2\. Read today’s events\./)
    expect(parseSkillFile(renderSkillMd(d)).manifest.permissions.input).toBe(true)
    expect(actionSteps('open it, then save; close after that quit')).toEqual([
      'Open it',
      'Save',
      'Close',
      'Quit'
    ])
  })
})

describe('watch-me recorder output (T11)', () => {
  it('turns recorded steps into steps.json with a parameter for typed text', () => {
    const r = skeletonToSteps([
      { kind: 'invoked', name: 'File', role: 'menu item', opened: [] },
      {
        kind: 'invoked',
        name: 'Export As…',
        role: 'menu item',
        automationId: 'export',
        opened: []
      },
      { kind: 'text', name: 'File name', role: 'edit', opened: [] },
      { kind: 'key', combo: 'Ctrl+Shift+E', opened: [] },
      { kind: 'selected', role: 'list item', opened: [] }
    ])
    expect(r.params).toEqual([{ name: 'file_name', description: 'what to type in File name' }])
    expect(r.steps).toEqual([
      { do: 'invoke', target: { name: 'File', role: 'menu item' } },
      { do: 'invoke', target: { name: 'Export As…', role: 'menu item', automationId: 'export' } },
      { do: 'set_value', target: { name: 'File name', role: 'edit' }, value: '{file_name}' },
      { do: 'keys', combo: 'ctrl+shift+e' }
    ])
  })
})

describe('names and voice commands', () => {
  it('makes names', () => {
    expect(slugName("Export as PNG! (GIMP's)")).toBe('export-as-png-gimps')
    expect(slugName('!!!')).toBe('')
    const taken = new Set(['a', 'a-2'])
    expect(freeName('a', (n) => taken.has(n))).toBe('a-3')
    expect(freeName('Not Valid', () => false)).toBe('my-skill')
    const used = new Set<string>()
    expect([
      paramName('File name', used),
      paramName('File name', used),
      paramName('2nd', used)
    ]).toEqual(['file_name', 'file_name_2', 'v_2nd'])
  })

  it('matches the creation phrases', () => {
    expect(matchCreateIntent('Save that as a skill')).toEqual({ kind: 'save-last' })
    expect(matchCreateIntent('save that as a skill called mail report')).toEqual({
      kind: 'save-last',
      name: 'mail report'
    })
    expect(matchCreateIntent('turn that into a skill')).toEqual({ kind: 'save-last' })
    expect(matchCreateIntent('watch me make a skill to export png')).toEqual({
      kind: 'record',
      title: 'export png'
    })
    expect(matchCreateIntent('record a new skill')).toEqual({ kind: 'record' })
    expect(matchCreateIntent('when I say hi, wave')).toMatchObject({ kind: 'when', phrase: 'hi' })
    expect(matchCreateIntent('watch me turn on dark mode')).toBeNull()
    expect(matchCreateIntent('save the file')).toBeNull()
  })

  it('matches review commands', () => {
    expect(matchDraftCommand('Save it.')).toEqual({ cmd: 'save' })
    expect(matchDraftCommand('save it as mail report')).toEqual({
      cmd: 'save',
      name: 'mail report'
    })
    expect(matchDraftCommand('call it weekly mail')).toEqual({ cmd: 'rename', name: 'weekly mail' })
    expect(matchDraftCommand('trigger it with send the report')).toEqual({
      cmd: 'trigger',
      phrase: 'send the report'
    })
    expect(matchDraftCommand('read it back')).toEqual({ cmd: 'read' })
    expect(matchDraftCommand('discard it')).toEqual({ cmd: 'discard' })
    expect(matchDraftCommand('yes')).toEqual({ cmd: 'yes' })
    expect(matchDraftCommand('open my mail')).toBeNull()
  })
})
