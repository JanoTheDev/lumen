import { describe, expect, it } from 'vitest'
import {
  findHelpGroup,
  helpGroups,
  helpTopicText,
  registerHelpRows,
  topicKey
} from '../../src/main/a11y/help-topics'
import {
  IDLE_CONTEXT,
  commandSheetRows,
  helpTopic,
  parseCommand
} from '../../src/main/a11y/voice-commands'

describe('help topics (registerHelpRows)', () => {
  it('normalises spoken topics', () => {
    expect(topicKey('the Buddies')).toBe('buddy')
    expect(topicKey('my notes')).toBe('note')
    expect(topicKey('news')).toBe('news')
    expect(topicKey('focus')).toBe('focus')
    expect(topicKey('reply styles')).toBe('reply style')
  })

  it('has built-in groups for the other voice grammars', () => {
    const titles = helpGroups().map((g) => g.title)
    for (const t of [
      'Answers',
      'Buddies',
      'Automations',
      'Smart helpers',
      'Head pointer',
      'Memory and privacy',
      'Reply styles',
      'Notes',
      'Files and documents',
      'Answer cards',
      'Web and news',
      'Claude Code'
    ])
      expect(titles).toContain(t)
    for (const g of helpGroups()) expect(g.rows.length).toBeLessThanOrEqual(6)
  })

  it('finds a group by its name or one of its words, longest word first', () => {
    expect(findHelpGroup('buddies')?.title).toBe('Buddies')
    expect(findHelpGroup('the head pointer')?.title).toBe('Head pointer')
    expect(findHelpGroup('focus mode')?.title).toBe('Smart helpers')
    expect(findHelpGroup('private mode')?.title).toBe('Memory and privacy')
    expect(findHelpGroup('styles')?.title).toBe('Reply styles')
    expect(findHelpGroup('the news')?.title).toBe('Web and news')
    expect(findHelpGroup('Claude Code')?.title).toBe('Claude Code')
    expect(findHelpGroup('my taxes')).toBeNull()
  })

  it('registers, replaces and removes a group', () => {
    const off = registerHelpRows('Voice settings', () => [
      { say: 'make the voice slower', does: 'Speak slower' }
    ])
    expect(findHelpGroup('voice settings')?.rows).toEqual([
      { say: 'make the voice slower', does: 'Speak slower' }
    ])
    const off2 = registerHelpRows('Voice settings', () => [{ say: 'louder', does: 'Louder' }], {
      words: ['speech']
    })
    off() // the replaced registration no longer removes anything
    expect(findHelpGroup('speech')?.rows[0].say).toBe('louder')
    off2()
    expect(findHelpGroup('voice settings')).toBeNull()
  })

  it('a group whose rows throw or are empty is left out', () => {
    const off = registerHelpRows('Broken', () => {
      throw new Error('boom')
    })
    const off2 = registerHelpRows('Empty', () => [])
    expect(helpGroups().map((g) => g.title)).not.toContain('Broken')
    expect(findHelpGroup('empty')).toBeNull()
    off()
    off2()
  })

  it('registered rows join the help sheet, one section per group', () => {
    const off = registerHelpRows('Test group', () => [{ say: 'do the test', does: 'Tests' }])
    const rows = commandSheetRows(IDLE_CONTEXT)
    expect(rows).toContainEqual({
      category: 'Test group',
      say: 'do the test',
      does: 'Tests',
      now: true
    })
    off()
  })

  it('speaks a short line per group, at most five phrases', () => {
    const text = helpTopicText({
      title: 'Buddies',
      rows: Array.from({ length: 7 }, (_, i) => ({ say: `say ${i}`, does: `Does ${i}` }))
    })
    expect(text).toMatch(/^For buddies, you can say: “say 0”: does 0\./)
    expect(text).toContain('“say 4”')
    expect(text).not.toContain('“say 5”')
    expect(text).toMatch(/The help sheet has more\.$/)
  })

  it('falls back to the grammar sections ("what can I say about scrolling")', () => {
    const g = helpTopic('scrolling')
    expect(g?.title).toBe('Scrolling')
    expect(g?.rows.some((r) => r.say === 'scroll down')).toBe(true)
    expect(helpTopic('the weather')).toBeNull()
  })

  it('"what can I say about buddies" parses as a help topic', () => {
    for (const u of [
      'what can I say about buddies',
      'help with automations',
      'what can I say for the head pointer',
      'show commands for notes'
    ]) {
      const c = parseCommand(u)
      expect(c?.id, u).toBe('lumen.help-topic')
    }
    expect(parseCommand('what can I say')?.id).toBe('lumen.help')
    expect(parseCommand('show commands')?.id).toBe('lumen.help')
  })
})
