// A buddy on screen (08 T52): which runs go to the foreground, the foreground stand-in skill's
// tools and permission check, and the run under the buddy's envelope with buddy.working around it.
import { describe, expect, it, vi } from 'vitest'
import type { Buddy } from '@shared/buddies'
import type { ModelResponse } from '@shared/types'
import type { SkillEnvelope } from '../../src/main/agent-mode/skill-envelope'
import { clampBuddy } from '../../src/main/buddies/clamp'
import {
  buddyForegroundManifest,
  chooseLane,
  foregroundPrompt,
  foregroundTools,
  needsScreen,
  runBuddyForeground,
  type ForegroundDeps
} from '../../src/main/buddies/foreground'
import { checkSkillCall, classifyToolCall } from '../../src/main/skills/permissions'

const make = (permissions: Record<string, unknown>, extra: Record<string, unknown> = {}): Buddy =>
  clampBuddy(
    'mail-buddy',
    {
      name: 'Mail Buddy',
      instructions: 'Sort my mail.',
      trust: 'mine',
      permissions,
      ...extra
    },
    { now: 1 }
  )

describe('lanes', () => {
  const screen = make({ input: true, screen: true })
  const plain = make({ tools: ['fetch_url'] })
  it('only a buddy that needs the screen, with the user present and the screen free', () => {
    expect(needsScreen(screen)).toBe(true)
    expect(needsScreen(plain)).toBe(false)
    const base = { trigger: 'call' as const, present: true, agentBusy: false }
    expect(chooseLane(screen, base)).toBe('foreground')
    expect(chooseLane(plain, base)).toBe('background')
    expect(chooseLane(screen, { ...base, agentBusy: true })).toBe('background')
    expect(chooseLane(screen, { ...base, present: false })).toBe('background')
  })
  it('a scheduled run also needs its pre-approval', () => {
    const s = { trigger: 'schedule' as const, present: true, agentBusy: false }
    expect(chooseLane(screen, s)).toBe('background')
    expect(chooseLane(screen, { ...s, preApproved: true })).toBe('foreground')
  })
})

describe('the foreground stand-in skill', () => {
  it('offers screen tools by permission', () => {
    expect(foregroundTools(make({ screen: true }))).toEqual([
      'finish',
      'ask_user',
      'memory_write',
      'observe',
      'wait_for'
    ])
    const full = make({
      input: true,
      network: ['https://shop.example.com'],
      tools: ['lookup_howto', 'fetch_url']
    })
    expect(foregroundTools(full)).toEqual([
      'finish',
      'ask_user',
      'memory_write',
      'observe',
      'wait_for',
      'act',
      'keys',
      'launch_app',
      'navigate',
      'lookup_howto'
    ])
  })

  it('the skill check refuses what the buddy may not do', () => {
    const seeOnly = buddyForegroundManifest(make({ screen: true }))
    const ok = (m: typeof seeOnly, tool: string, input: Record<string, unknown> = {}): boolean =>
      checkSkillCall(m, 'mine', classifyToolCall(tool, input, null)).ok
    expect(ok(seeOnly, 'observe')).toBe(true)
    expect(ok(seeOnly, 'act')).toBe(false)
    expect(ok(seeOnly, 'navigate', { url: 'https://x.example.com' })).toBe(false)
    const hands = buddyForegroundManifest(
      make({ input: true, network: ['https://shop.example.com'] })
    )
    expect(ok(hands, 'act')).toBe(true)
    expect(ok(hands, 'navigate', { url: 'https://shop.example.com/a' })).toBe(true)
    expect(ok(hands, 'navigate', { url: 'https://evil.example.org/' })).toBe(false)
    expect(ok(hands, 'mcp__gmail__send')).toBe(false)
  })

  it('the goal fences the notebook as data', () => {
    const b = make({ screen: true })
    const p = foregroundPrompt(b, { trigger: 'call', utterance: 'tidy up' }, 'Boss is Ann.')
    expect(p).toContain('The user asks you now: tidy up')
    expect(p).toContain('<observed source="buddy-notebook">\nBoss is Ann.\n</observed>')
  })
})

describe('runBuddyForeground', () => {
  it('runs under the buddy envelope and usage scope, with buddy.working around it', async () => {
    const b = make({ input: true })
    const events: [string, boolean][] = []
    const envelope = { skill: 'Mail Buddy (buddy)' } as SkillEnvelope
    const made: string[] = []
    const deps: ForegroundDeps = {
      runTask: vi.fn(async (_prompt, _signal, o) => {
        expect(events).toEqual([['mail-buddy', true]])
        expect(o.underEnvelope.make('t_1', { speak: () => {} })).toBe(envelope)
        expect(o.underEnvelope.scope).toEqual({ origin: 'buddy', buddyId: 'mail-buddy' })
        expect(o.userText).toBe('Sort my mail.\nfile the receipts')
        expect(o.observedText).toBe('notes')
        return { mode: 'answer', text: 'Done.' } as ModelResponse
      }),
      envelope: (s, taskId) => {
        made.push(`${s.manifest.name}:${taskId}:${s.manifest.tools?.join(',')}`)
        return envelope
      },
      notebook: () => 'notes',
      memoryWrite: () => 'ok',
      runs: { start: () => {}, end: () => {} },
      working: (id, active) => events.push([id, active]),
      now: () => 1
    }
    const r = await runBuddyForeground(
      b,
      { trigger: 'call', utterance: 'file the receipts' },
      new AbortController().signal,
      deps
    )
    expect(r).toEqual({ mode: 'answer', text: 'Done.' })
    expect(made).toEqual([
      'Mail Buddy (buddy):t_1:finish,ask_user,memory_write,observe,wait_for,act,keys,launch_app'
    ])
    expect(events).toEqual([
      ['mail-buddy', true],
      ['mail-buddy', false]
    ])
  })

  it('says it stopped working when the task fails', async () => {
    const events: boolean[] = []
    await expect(
      runBuddyForeground(make({ input: true }), { trigger: 'call' }, new AbortController().signal, {
        runTask: async () => {
          throw new Error('boom')
        },
        envelope: () => ({}) as SkillEnvelope,
        notebook: () => '',
        memoryWrite: () => 'ok',
        runs: { start: () => {}, end: () => {} },
        working: (_id, a) => events.push(a),
        now: () => 1
      })
    ).rejects.toThrow('boom')
    expect(events).toEqual([true, false])
  })
})
