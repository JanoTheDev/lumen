import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'
import {
  findCorrections,
  looksLikeName,
  noteCorrections,
  withLearned
} from '../../src/main/speech/dictation/learn'
import { watchCorrections } from '../../src/main/speech/dictation/learn-watch'
import type { AgentBridge } from '../../src/main/agent/bridge'
import { tempDir } from '../helpers/fixtures'

describe('findCorrections', () => {
  it('finds a dictated word the user capitalised', () => {
    expect(
      findCorrections(
        'I designed it in figma yesterday',
        'Notes: I designed it in figma yesterday',
        'Notes: I designed it in Figma yesterday'
      )
    ).toEqual([{ from: 'figma', to: 'Figma' }])
  })

  it('finds brand casing and close respellings', () => {
    expect(findCorrections('push to github', 'push to github', 'push to GitHub')).toEqual([
      { from: 'github', to: 'GitHub' }
    ])
    expect(findCorrections('open da vinchi', 'open vinchi', 'open Vinci')).toEqual([
      { from: 'vinchi', to: 'Vinci' }
    ])
  })

  it('ignores rewrites, words that were not dictated and lowercase edits', () => {
    expect(findCorrections('send the report', 'send the report', 'send the summary')).toEqual([])
    expect(findCorrections('hello', 'figma hello', 'Figma hello')).toEqual([])
    expect(findCorrections('the cat sat', 'the cat sat', 'the bat sat')).toEqual([])
    expect(findCorrections('it is fine', 'it is fine', 'it is fine and more text')).toEqual([])
  })

  it('needs one word for one word', () => {
    expect(findCorrections('a b c', 'a b c', 'a Xx Yy c')).toEqual([])
  })
})

describe('looksLikeName', () => {
  it.each([
    ['Figma', 'figma', true],
    ['iPhone', 'iphone', true],
    ['DaVinci', 'davinci', true],
    ['figma', 'Figma', false],
    ['Table', 'cable', true],
    ['Anything', 'thing', false],
    ['42', '41', false]
  ])('%s from %s → %s', (to, from, want) => {
    expect(looksLikeName(to, from)).toBe(want)
  })
})

describe('noteCorrections', () => {
  it('learns a correction seen twice', () => {
    const tmp = tempDir()
    const path = join(tmp.dir, 'dictionary.json')
    try {
      const fix = [{ from: 'figma', to: 'Figma' }]
      expect(noteCorrections(fix, [], path)).toEqual([])
      expect(JSON.parse(readFileSync(path, 'utf8')).candidates['figma→Figma'].count).toBe(1)
      expect(noteCorrections(fix, [], path)).toEqual(['Figma'])
      expect(JSON.parse(readFileSync(path, 'utf8')).candidates).toEqual({})
    } finally {
      tmp.cleanup()
    }
  })

  it('skips words already in the dictionary', () => {
    const tmp = tempDir()
    const path = join(tmp.dir, 'dictionary.json')
    try {
      const fix = [{ from: 'figma', to: 'Figma' }]
      noteCorrections(fix, ['Figma'], path)
      expect(noteCorrections(fix, ['Figma'], path)).toEqual([])
    } finally {
      tmp.cleanup()
    }
  })

  it('a learned spelling replaces its case variant', () => {
    expect(withLearned(['figma', 'Blender'], ['Figma'])).toEqual(['Blender', 'Figma'])
  })
})

describe('watchCorrections', () => {
  function fakeAgent(reads: string[]): AgentBridge {
    let i = 0
    return {
      hasCapability: (c: string) => c === 'uia-text',
      request: async (cmd: string) =>
        cmd === 'focus_info'
          ? { process: 'notepad.exe' }
          : {
              text: reads[Math.min(i++, reads.length - 1)],
              source: 'text',
              role: 'document',
              name: 'Text editor'
            }
    } as unknown as AgentBridge
  }

  it('reads now and 20 s later, then reports what it learned', async () => {
    const tmp = tempDir()
    const timers: Array<() => void> = []
    const learned: string[][] = []
    const deps = {
      dictionary: () => [] as string[],
      learned: (_d: string[], added: string[]) => learned.push(added),
      storePath: join(tmp.dir, 'dictionary.json'),
      setTimer: (fn: () => void) => timers.push(fn),
      clearTimer: () => {}
    }
    const flush = async (): Promise<void> => {
      const fn = timers.shift()
      fn?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      for (let round = 0; round < 2; round++) {
        watchCorrections(fakeAgent(['made in figma', 'made in Figma']), 'made in figma', deps)
        await flush()
        await flush()
      }
      expect(learned).toEqual([['Figma']])
      // L6: the corrected words never reach main.log, only how many there were.
      const lines = logs.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('dictation corrections: 1'))).toBe(true)
      expect(lines.some((l) => /figma/i.test(l))).toBe(false)
    } finally {
      logs.mockRestore()
      tmp.cleanup()
    }
  })

  it('does nothing without uia_text', () => {
    const timers: unknown[] = []
    const agent = { hasCapability: () => false } as unknown as AgentBridge
    watchCorrections(agent, 'x', {
      dictionary: () => [],
      learned: () => {},
      setTimer: (fn) => timers.push(fn)
    })
    expect(timers).toEqual([])
  })
})
