import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expandSnippet,
  loadSnippets,
  matchSnippet,
  saveSnippets,
  type Snippet
} from '../../../src/main/speech/dictation/snippets'

const list: Snippet[] = [
  { id: 'a', trigger: 'my calendar link', text: 'https://cal.example/me' },
  { id: 'b', trigger: 'sign off', text: 'Best,\nJan' },
  { id: 'c', trigger: 'home address', text: '1 Main Street' }
]

describe('matchSnippet', () => {
  it('matches the whole utterance, with or without a lead verb', () => {
    expect(matchSnippet('insert my calendar link', list)?.snippet.id).toBe('a')
    expect(matchSnippet('insert my calendar link', list)?.lead).toBe(true)
    expect(matchSnippet('My calendar link.', list)?.snippet.id).toBe('a')
    expect(matchSnippet('my calendar link', list)?.lead).toBe(false)
    expect(matchSnippet('calendar link', list)?.snippet.id).toBe('a')
    expect(matchSnippet('type my home address please', list)?.snippet.id).toBe('c')
    expect(matchSnippet('sign of', list)?.snippet.id).toBe('b')
  })

  it('does not match a sentence that only mentions the phrase', () => {
    expect(matchSnippet('I will send you my calendar link tomorrow', list)).toBeNull()
    expect(matchSnippet('sign', list)).toBeNull()
  })
})

describe('expandSnippet', () => {
  it('fills variables', () => {
    const now = new Date(2026, 9, 1, 9, 5)
    const out = expandSnippet('{day} {date} {time} {clipboard}', { now, clipboard: () => 'clip' })
    expect(out).toContain('clip')
    expect(out).toContain('2026')
    expect(out).not.toContain('{')
  })

  it('leaves unknown braces alone', () => {
    expect(expandSnippet('{name}')).toBe('{name}')
  })
})

describe('snippet store', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('saves with ids, drops duplicate triggers and reads back', () => {
    dir = mkdtempSync(join(tmpdir(), 'snip-'))
    const path = join(dir, 'snippets.json')
    const saved = saveSnippets(
      [
        { trigger: 'sign off', text: 'Best' },
        { trigger: 'Sign off!', text: 'dup' },
        { id: 'x', trigger: 'my link', text: 'L' }
      ],
      path
    )
    expect(saved.map((s) => s.trigger)).toEqual(['sign off', 'my link'])
    expect(saved[0].id).toBeTruthy()
    expect(loadSnippets(path)).toEqual(saved)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('ignores a broken file', () => {
    dir = mkdtempSync(join(tmpdir(), 'snip-'))
    const path = join(dir, 'snippets.json')
    writeFileSync(path, '{"version":1,"snippets":[{"trigger":1}]}')
    expect(loadSnippets(path)).toEqual([])
    expect(loadSnippets(join(dir, 'missing.json'))).toEqual([])
  })
})
