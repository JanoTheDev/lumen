import { describe, expect, it } from 'vitest'
import { normalize, parseManageCommand } from '../../src/main/voice-manage/grammar'
import { matchNamed, resolveWhich } from '../../src/main/voice-manage/match'
import { parseAutomationUtterance } from '../../src/main/routines/parse'
import { matchEditIntent } from '../../src/main/skills/edit'
import { matchTaskChatIntent } from '../../src/main/agent-mode/transcript-voice'

const p = parseManageCommand

describe('normalize', () => {
  it('drops wake words, please and punctuation', () => {
    expect(normalize('Hey Lumen, please stop the Email task!')).toBe('stop the email task')
    expect(normalize('Can you list my tasks please?')).toBe('list my tasks')
    expect(normalize('What’s running?')).toBe('whats running')
  })
})

describe('tasks', () => {
  it('lists', () => {
    for (const s of [
      'what are you working on',
      'What are you working on right now?',
      "what's running",
      'list my tasks',
      'what tasks are running',
      'what are my tasks'
    ])
      expect(p(s), s).toEqual({ kind: 'tasks-list' })
  })

  it('controls a task by name', () => {
    expect(p('stop the email task')).toEqual({ kind: 'task-control', op: 'stop', name: 'email' })
    expect(p('cancel my price check task')).toEqual({
      kind: 'task-control',
      op: 'stop',
      name: 'price check'
    })
    expect(p('pause the lamp background task')).toEqual({
      kind: 'task-control',
      op: 'pause',
      name: 'lamp'
    })
    expect(p('resume the email task')).toMatchObject({ op: 'resume', name: 'email' })
    expect(p('run the price check task again')).toEqual({
      kind: 'task-control',
      op: 'run-again',
      name: 'price check'
    })
    expect(p('rerun the price task')).toMatchObject({ op: 'run-again', name: 'price' })
  })

  it('leaves the running task’s own words alone', () => {
    for (const s of [
      'stop',
      'stop it',
      'pause',
      'pause the task',
      'stop the task',
      'resume the task',
      'stop the background task',
      'cancel the current task',
      'continue'
    ])
      expect(p(s), s).toBeNull()
  })

  it('all tasks', () => {
    expect(p('stop all background tasks')).toEqual({
      kind: 'tasks-all',
      op: 'stop',
      background: true
    })
    expect(p('pause all my tasks')).toEqual({ kind: 'tasks-all', op: 'pause', background: false })
    expect(p('resume all background tasks')).toMatchObject({ op: 'resume' })
  })

  it('questions and answers', () => {
    expect(p('what’s the email task asking')).toEqual({ kind: 'task-question', name: 'email' })
    expect(p('what is the price task asking me')).toEqual({
      kind: 'task-question',
      name: 'price'
    })
    expect(p('what does the task want')).toEqual({ kind: 'task-question', name: '' })
    expect(p('is anything waiting for me')).toEqual({ kind: 'task-question', name: '' })
    expect(p('approve it')).toEqual({ kind: 'task-answer', approve: true, name: '' })
    expect(p('deny it')).toEqual({ kind: 'task-answer', approve: false, name: '' })
    expect(p('approve the email task')).toEqual({
      kind: 'task-answer',
      approve: true,
      name: 'email'
    })
  })

  it('does not take the task chat phrases', () => {
    expect(p('show me what the email task is doing')).toBeNull()
    expect(p('what’s the email task doing')).toBeNull()
    expect(p('tell the background task to also check Outlook')).toBeNull()
    // and the task chat does not take ours
    expect(matchTaskChatIntent('stop the email task')).toBeNull()
    expect(matchTaskChatIntent('what’s the email task asking')).toBeNull()
  })
})

describe('automations', () => {
  it('on and off', () => {
    expect(p('turn off my morning routine')).toEqual({
      kind: 'automation-enable',
      name: 'morning',
      on: false
    })
    expect(p('turn on the morning automation')).toMatchObject({ name: 'morning', on: true })
    expect(p('turn the dentist reminder off')).toMatchObject({ name: 'dentist', on: false })
    expect(p('turn the dentist reminder back on')).toMatchObject({ on: true })
    expect(p('disable the backup automation')).toMatchObject({ name: 'backup', on: false })
    expect(p('pause the backup automation')).toMatchObject({ kind: 'automation-enable', on: false })
  })

  it('delete', () => {
    expect(p('delete the morning automation')).toEqual({
      kind: 'automation-delete',
      name: 'morning'
    })
    expect(p('cancel my dentist reminder')).toEqual({ kind: 'automation-delete', name: 'dentist' })
    expect(p('remove the automation called inbox sweep')).toEqual({
      kind: 'automation-delete',
      name: 'inbox sweep'
    })
    // "delete that automation" is the routines module's (the one just made).
    expect(p('delete that automation')).toBeNull()
  })

  it('run now', () => {
    expect(p('run the morning automation now')).toEqual({
      kind: 'automation-run',
      name: 'morning',
      loose: false
    })
    expect(p('run morning briefing now')).toEqual({
      kind: 'automation-run',
      name: 'morning briefing',
      loose: true
    })
    expect(p('run the tests')).toBeNull()
  })

  it('the automation grammar does not take these', () => {
    const opts = { now: Date.UTC(2026, 9, 3, 10), resolveFolder: () => null }
    for (const s of [
      'turn off my morning routine',
      'delete the morning automation',
      'run the morning automation now',
      'cancel my dentist reminder'
    ])
      expect(parseAutomationUtterance(s, opts), s).toBeNull()
  })
})

describe('skills', () => {
  it('list, on / off, delete', () => {
    expect(p('what skills do I have')).toEqual({ kind: 'skills-list' })
    expect(p('list my skills')).toEqual({ kind: 'skills-list' })
    expect(p('turn off the invoice skill')).toEqual({
      kind: 'skill-enable',
      name: 'invoice',
      on: false
    })
    expect(p('enable my good morning skill')).toMatchObject({ name: 'good morning', on: true })
    expect(p('delete the invoice skill')).toEqual({ kind: 'skill-delete', name: 'invoice' })
  })

  it('leaves questions and edits alone', () => {
    for (const s of [
      'how do I delete a skill in Photoshop',
      'delete a skill',
      'delete the skill',
      'what skills is Claude using here',
      'change my morning skill to also open Slack',
      'update the email skill',
      'make a skill that opens Slack'
    ])
      expect(p(s), s).toBeNull()
    expect(matchEditIntent('turn off the invoice skill')).toBeNull()
    expect(matchEditIntent('delete the invoice skill')).toBeNull()
  })
})

describe('buddies', () => {
  it('delete by name', () => {
    expect(p('delete Inbox Buddy')).toEqual({ kind: 'buddy-delete', name: 'inbox buddy' })
    expect(p('remove the price buddy')).toEqual({ kind: 'buddy-delete', name: 'price buddy' })
    expect(p('delete my buddy called Inbox')).toEqual({ kind: 'buddy-delete', name: 'inbox' })
    expect(p('delete the buddy')).toBeNull()
    expect(p('delete all buddies')).toBeNull()
    // a skill with "buddy" in its name is a skill
    expect(p('delete the buddy skill')).toEqual({ kind: 'skill-delete', name: 'buddy' })
  })
})

describe('grants', () => {
  it('list, revoke, revoke all', () => {
    expect(p('what have I always allowed')).toEqual({ kind: 'grants-list' })
    expect(p('what do you always allow')).toEqual({ kind: 'grants-list' })
    expect(p('list my permissions')).toEqual({ kind: 'grants-list' })
    expect(p('stop always allowing Outlook')).toEqual({ kind: 'grant-revoke', name: 'outlook' })
    expect(p('revoke the permission for github.com')).toEqual({
      kind: 'grant-revoke',
      name: 'github com'
    })
    expect(p('revoke all permissions')).toEqual({ kind: 'grants-revoke-all' })
    expect(p('stop always allowing everything')).toEqual({ kind: 'grants-revoke-all' })
  })
})

describe('audit, notes, memory, connectors, guides, diagnostics', () => {
  it('audit', () => {
    expect(p('what did you do today')).toEqual({ kind: 'audit-day', day: 'today' })
    expect(p('what have you done on my computer yesterday')).toEqual({
      kind: 'audit-day',
      day: 'yesterday'
    })
    // "what did you just do" stays the safety layer's
    expect(p('what did you just do')).toBeNull()
    expect(p('what did you do')).toBeNull()
    expect(p('what did we do today')).toBeNull()
  })

  it('notes', () => {
    expect(p('read my notes')).toEqual({ kind: 'notes-read', last: false })
    expect(p('read me my last note')).toEqual({ kind: 'notes-read', last: true })
    expect(p('what was my last note')).toEqual({ kind: 'notes-read', last: true })
    expect(p('delete my last note')).toEqual({ kind: 'note-delete-last' })
    expect(p('take a note buy milk')).toBeNull()
  })

  it('memory', () => {
    expect(p('export my memory')).toEqual({ kind: 'memory-export' })
    expect(p('forget everything about me')).toEqual({ kind: 'memory-delete-all' })
    expect(p('delete all my memory')).toEqual({ kind: 'memory-delete-all' })
    expect(p('forget about the trip')).toBeNull()
    expect(p('what do you remember about me')).toBeNull()
  })

  it('connectors', () => {
    expect(p('what connectors do I have')).toEqual({ kind: 'connectors-list' })
    expect(p('test my GitHub connector')).toEqual({ kind: 'connector-test', name: 'github' })
    expect(p('sign in to GitHub')).toEqual({
      kind: 'connector-sign-in',
      name: 'github',
      loose: true
    })
    expect(p('log into the notion connector')).toEqual({
      kind: 'connector-sign-in',
      name: 'notion',
      loose: false
    })
    expect(p('connect Linear')).toEqual({ kind: 'connector-sign-in', name: 'linear', loose: true })
  })

  it('guides', () => {
    expect(p('list my guides')).toEqual({ kind: 'guides-list' })
    expect(p('what guides do I have')).toEqual({ kind: 'guides-list' })
    expect(p('delete the printer guide')).toEqual({ kind: 'guide-delete', name: 'printer' })
    expect(p('play the printer guide')).toBeNull()
  })

  it('diagnostics', () => {
    expect(p('export diagnostics')).toEqual({ kind: 'diagnostics-export' })
    expect(p('send a bug report file')).toEqual({ kind: 'diagnostics-export' })
    expect(p('make a bug report')).toEqual({ kind: 'diagnostics-export' })
  })
})

describe('ordinary requests are not ours', () => {
  it.each([
    'what are you doing',
    'stop',
    'cancel',
    'what is running on port 3000 in my terminal',
    'how do I stop a task in Asana',
    'delete this email',
    'delete the file',
    'turn off the lights',
    'turn off wifi',
    'remove the dead body',
    'open my notes app',
    'what time is it',
    'send email to Bob',
    'run',
    'approve the pull request on github and merge it'
  ])('%s', (s) => {
    const c = p(s)
    // Loose shapes only claim once a real name fits (service tests); none of these is one here.
    if (c)
      expect(['automation-run', 'connector-sign-in', 'buddy-delete', 'task-answer']).toContain(
        c.kind
      )
    else expect(c).toBeNull()
  })

  it('are null outright', () => {
    for (const s of [
      'what are you doing',
      'stop',
      'how do I stop a task in Asana',
      'delete this email',
      'turn off the lights',
      'open my notes app',
      'what time is it'
    ])
      expect(p(s), s).toBeNull()
  })
})

describe('matchNamed', () => {
  const items = [
    { id: 'a', name: 'Morning briefing' },
    { id: 'b', name: 'Morning backup' },
    { id: 'c', name: 'Check the price of the lamp every hour' }
  ]

  it('prefers the whole name', () => {
    expect(matchNamed('morning briefing', items)).toEqual({ ids: ['a'], tier: 3 })
    expect(matchNamed('briefing morning', items).ids).toEqual(['a'])
  })

  it('takes part of a name and a misheard letter', () => {
    expect(matchNamed('lamp', items)).toEqual({ ids: ['c'], tier: 1 })
    expect(matchNamed('mornin briefing', items).ids).toEqual(['a'])
    expect(matchNamed('prices', items).ids).toEqual(['c'])
  })

  it('is ambiguous on a shared word', () => {
    expect(matchNamed('morning', items).ids.sort()).toEqual(['a', 'b'])
  })

  it('nothing fits', () => {
    expect(matchNamed('weather', items).ids).toEqual([])
    expect(matchNamed('the', items).ids).toEqual([])
  })

  it('answers which one', () => {
    const opts = items.slice(0, 2)
    expect(resolveWhich('the second one', opts)).toBe('b')
    expect(resolveWhich('briefing', opts)).toBe('a')
    expect(resolveWhich('the backup one please', opts)).toBe('b')
    expect(resolveWhich('open my email', opts)).toBeNull()
  })
})
