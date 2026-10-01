import { describe, expect, it } from 'vitest'
import { parseHelperCommand as p } from '../../src/main/coach/grammar'

describe('helper voice commands', () => {
  it('focus mode on / off / levels / areas', () => {
    expect(p('Focus mode on.')).toEqual({ kind: 'focus-on' })
    expect(p('turn on focus mode')).toEqual({ kind: 'focus-on' })
    expect(p('declutter this app')).toEqual({ kind: 'focus-on' })
    expect(p('strong focus')).toEqual({ kind: 'focus-on', level: 'strong' })
    expect(p('only show the viewport')).toEqual({ kind: 'focus-on', region: 'viewport' })
    expect(p('focus mode on the properties panel')).toEqual({
      kind: 'focus-on',
      region: 'properties panel'
    })
    expect(p('focus mode off')).toEqual({ kind: 'focus-off' })
    expect(p('turn off focus mode')).toEqual({ kind: 'focus-off' })
    expect(p('Show everything, please')).toEqual({ kind: 'focus-off' })
    expect(p('only show everything')).toBeNull()
  })

  it('undo', () => {
    expect(p('undo that')).toEqual({ kind: 'undo', n: 1, that: true })
    expect(p('undo your last action')).toEqual({ kind: 'undo', n: 1 })
    expect(p('undo the last 3 things')).toEqual({ kind: 'undo', n: 3 })
    expect(p('undo the last three steps')).toEqual({ kind: 'undo', n: 3 })
    expect(p('undo the last couple of things')).toEqual({ kind: 'undo', n: 2 })
    expect(p('undo what you just did')).toEqual({ kind: 'undo-task' })
    expect(p('undo everything you did')).toEqual({ kind: 'undo-task' })
    expect(p('undo the last 99 things')).toBeNull()
    expect(p('undo')).toBeNull()
  })

  it('what changed', () => {
    expect(p('What changed?')).toEqual({ kind: 'what-changed' })
    expect(p('did it work')).toEqual({ kind: 'what-changed' })
    expect(p('where did the new window go')).toEqual({ kind: 'what-changed' })
  })

  it('reading level, global and for this app', () => {
    expect(p('explain simpler')).toEqual({ kind: 'reading-level', level: 'simpler', here: false })
    expect(p('use simpler words in this app')).toEqual({
      kind: 'reading-level',
      level: 'simpler',
      here: true
    })
    expect(p('more technical')).toEqual({ kind: 'reading-level', level: 'expert', here: false })
    expect(p('reading level plain')).toEqual({ kind: 'reading-level', level: 'plain', here: false })
    expect(p('normal explanations here')).toEqual({
      kind: 'reading-level',
      level: 'standard',
      here: true
    })
    // 06 owns "more detail" (after a screen description).
    expect(p('more detail')).toBeNull()
  })

  it('journal, error rescue, shortcut tips', () => {
    expect(p('what did I learn this week')).toEqual({ kind: 'journal', range: 'week' })
    expect(p('what have I learned today')).toEqual({ kind: 'journal', range: 'today' })
    expect(p('explain this error')).toEqual({ kind: 'explain-error' })
    expect(p('what does this error mean')).toEqual({ kind: 'explain-error' })
    expect(p('yes please')).toEqual({ kind: 'accept-offer' })
    expect(p('stop shortcut tips')).toEqual({ kind: 'shortcut-tips', on: false })
    expect(p('turn on shortcut tips')).toEqual({ kind: 'shortcut-tips', on: true })
  })

  it('leaves everything else to the model', () => {
    expect(p('open notepad')).toBeNull()
    expect(p('what changed in the latest version of blender and how do I use it now')).toBeNull()
    expect(p('')).toBeNull()
  })
})
