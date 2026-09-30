import { describe, it, expect } from 'vitest'
import { applyOverrides } from '../src/main/query/overrides'

// Characterization of prompt steering: captured from the behaviour before the query
// pipeline moved out of index.ts. Update snapshots only on purpose.
const CASES: Array<[prompt: string, activeWindow: string, lowDetail?: boolean]> = [
  ['open my third email', 'Inbox - Gmail - Google Chrome'],
  ['open the 2nd result', 'weather - Google Search - Google Chrome'],
  ['click this button', 'Settings'],
  ['open that link', 'Example Domain - Google Chrome'],
  ['where is the search box', 'Google - Google Chrome'],
  ['show me the emails from Stripe', 'Inbox - Gmail - Google Chrome'],
  ['show me positions for ExNIS internships', 'New Tab - Google Chrome'],
  ['what time is it', 'Untitled - Notepad'],
  ['open gmail', 'Untitled - Notepad'],
  ['check my gmail', 'Inbox - Gmail - Google Chrome'],
  ['reply to this and say thanks', 'Inbox - Gmail - Google Chrome'],
  ['rewrite this paragraph', 'Document1 - Word'],
  ['scroll down', 'Reddit - Google Chrome'],
  ['open youtube and search for lofi', 'Untitled - Notepad'],
  ['find the save button', 'Blender'],
  ['open the 3rd email', 'Inbox - Gmail - Google Chrome', true],
  ['open my third email in gmail', 'Untitled - Notepad'],
  ['show me the emails from Stripe in gmail', 'Untitled - Notepad'],
]

describe('applyOverrides', () => {
  it.each(CASES)('%s  [%s]', (prompt, activeWindow, lowDetail) => {
    const r = applyOverrides({ prompt, activeWindow, lowDetail, lastTaskContext: null })
    expect({
      effectivePrompt: r.effectivePrompt,
      flags: r.flags,
      mode: r.intent.mode,
      requestedApp: r.requestedApp,
      nextTaskContext: r.nextTaskContext === r.effectivePrompt ? '<effective>' : r.nextTaskContext,
    }).toMatchSnapshot()
  })

  it('app switch composes with the ordinal block instead of being replaced', () => {
    const r = applyOverrides({ prompt: 'open my third email in gmail', activeWindow: 'Untitled - Notepad', lastTaskContext: null })
    expect(r.flags).toEqual(['app-switch', 'ordinal'])
    expect(r.effectivePrompt).toContain('"type":"open_url"')
    expect(r.effectivePrompt).toContain('ordinal list request detected')
  })

  it('continuations re-run the previous task', () => {
    const first = applyOverrides({ prompt: 'write a resignation email in gmail', activeWindow: 'Inbox - Gmail', lastTaskContext: null })
    const next = applyOverrides({ prompt: 'do it', activeWindow: 'Inbox - Gmail', lastTaskContext: first.nextTaskContext })
    if (next.intent.isContinuation) {
      expect(next.effectivePrompt.startsWith(first.effectivePrompt)).toBe(true)
      expect(next.nextTaskContext).toBe(first.nextTaskContext)
    }
  })
})
