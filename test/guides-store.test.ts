import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setGuidesDir,
  saveGuide,
  listSavedGuides,
  loadSavedGuide,
  deleteSavedGuide,
  findGuideByName,
  isValidGuideId,
  guidePath,
  slugify,
  GUIDE_ID_RE
} from '../src/main/guides/store'

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guides-test-'))
  dir = join(root, 'guides')
  mkdirSync(dir)
  setGuidesDir(dir)
})

afterEach(() => {
  setGuidesDir(null)
  rmSync(root, { recursive: true, force: true })
})

const steps = [
  {
    label: 'Click Settings',
    target_hint: 'gear icon',
    bbox: [1, 2, 3, 4] as [number, number, number, number]
  }
]

describe('guide store', () => {
  it('saves, lists, loads and deletes', () => {
    const g = saveGuide('open settings in gmail', steps, 'Gmail settings')
    expect(g.name).toBe('Gmail settings')
    expect(GUIDE_ID_RE.test(g.id)).toBe(true)
    expect(listSavedGuides().map((x) => x.id)).toEqual([g.id])
    expect(loadSavedGuide(g.id)).toEqual(g)
    expect(deleteSavedGuide(g.id)).toBe(true)
    expect(loadSavedGuide(g.id)).toBeNull()
    expect(deleteSavedGuide(g.id)).toBe(false)
  })

  it('falls back to the task for the name', () => {
    const g = saveGuide('how to archive email', steps)
    expect(g.name).toBe('how to archive email')
    expect(g.id.startsWith('how-to-archive-email-')).toBe(true)
  })

  it('keeps ids within 64 chars for long names', () => {
    const g = saveGuide('x', steps, 'a'.repeat(200))
    expect(g.id.length).toBeLessThanOrEqual(64)
    expect(isValidGuideId(g.id)).toBe(true)
    expect(loadSavedGuide(g.id)).not.toBeNull()
  })

  it('refuses traversal on delete and leaves the file untouched', () => {
    const victim = join(root, 'config.json')
    writeFileSync(victim, '{"keep":true}', 'utf8')
    expect(deleteSavedGuide('../config')).toBe(false)
    expect(existsSync(victim)).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('{"keep":true}')
  })

  it('refuses traversal on load', () => {
    writeFileSync(join(root, 'config.json'), '{"mode":"x"}', 'utf8')
    expect(loadSavedGuide('../config')).toBeNull()
  })

  it.each([
    '../config',
    '..',
    '',
    '-lead',
    'UPPER',
    'a/b',
    'a\\b',
    'a.b',
    'C:',
    'a'.repeat(65),
    null,
    42
  ])('rejects id %s', (id) => {
    expect(isValidGuideId(id)).toBe(false)
    expect(guidePath(id)).toBeNull()
  })

  it('accepts well-formed ids', () => {
    expect(isValidGuideId('gmail-settings-abc123')).toBe(true)
    expect(isValidGuideId('a'.repeat(64))).toBe(true)
  })

  it('skips corrupt files when listing', () => {
    saveGuide('task', steps, 'good')
    writeFileSync(join(dir, 'bad.json'), '{nope', 'utf8')
    expect(listSavedGuides().map((g) => g.name)).toEqual(['good'])
  })

  it('finds guides by name', () => {
    saveGuide('t', steps, 'Gmail Settings')
    expect(findGuideByName('gmail')?.name).toBe('Gmail Settings')
    expect(findGuideByName('gmail-settings')?.name).toBe('Gmail Settings')
    expect(findGuideByName('slack')).toBeNull()
  })

  it('slugifies', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('!!!')).toBe('guide')
  })
})
