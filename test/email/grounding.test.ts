// Loose name matches for mail UIs (08 email): Gmail's "Send (Ctrl-Enter)" for "Send" and an inbox
// row for its sender, but only when exactly one element fits, and never a longer button name.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import type { ElementNode } from '@shared/types'
import { setScreenAdapter } from '../../src/main/actions/coords'
import { resolveTarget, type GroundingContext } from '../../src/main/query/resolve-target'

beforeAll(() =>
  setScreenAdapter({
    screenToDipPoint: (p) => p,
    dipToScreenPoint: (p) => p,
    screenToDipRect: (r) => r
  })
)
afterAll(() => setScreenAdapter(null))

const node = (id: string, role: string, name: string, y: number): ElementNode => ({
  id,
  role,
  name,
  rect: { x: 10, y, w: 200, h: 30 },
  monitorId: 0,
  enabled: true,
  patterns: ['invoke']
})

function ctx(children: ElementNode[]): GroundingContext {
  return {
    frames: [],
    uia: {
      snapshotId: 's',
      root: { ...node('e0', 'window', 'Mail', 0), rect: { x: 0, y: 0, w: 1920, h: 1040 }, children }
    }
  }
}

const id = async (text: string, children: ElementNode[]): Promise<string | null> =>
  (await resolveTarget({ kind: 'text', text }, ctx(children)))?.elementId ?? null

describe('mail grounding', () => {
  it('a name with a shortcut hint matches its label', async () => {
    expect(await id('Send', [node('e1', 'button', 'Send (Ctrl-Enter)', 10)])).toBe('e1')
    expect(
      await id('Discard draft', [node('e1', 'button', 'Discard draft (Ctrl-Shift-D)', 10)])
    ).toBe('e1')
  })

  it('never takes a longer button for a shorter label', async () => {
    expect(await id('Reply', [node('e1', 'button', 'Reply all', 10)])).toBeNull()
    expect(await id('Send', [node('e1', 'button', 'More send options', 10)])).toBeNull()
  })

  it('an exact name beats a loose one', async () => {
    const kids = [node('e1', 'button', 'Reply all', 10), node('e2', 'button', 'Reply', 50)]
    expect(await id('Reply', kids)).toBe('e2')
  })

  it('finds the one inbox row with the sender; two rows is no match', async () => {
    const rows = [
      node('e1', 'dataitem', 'unread, Anna Berg, Lunch on Friday, 10:42 AM', 10),
      node('e2', 'dataitem', 'Lumen Billing, Your invoice, 9:15 AM', 50),
      node('e3', 'dataitem', 'Anna Berg, Photos, Sep 29', 90)
    ]
    expect(await id('Lumen Billing', rows)).toBe('e2')
    expect(await id('Anna Berg', rows)).toBeNull()
    // Whole words only.
    expect(await id('Bill', rows)).toBeNull()
  })

  it('buttons are not matched by words inside their names', async () => {
    expect(await id('Anna', [node('e1', 'button', 'Reply to Anna', 10)])).toBeNull()
  })
})
