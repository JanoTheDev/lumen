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
    bbox: { x: 1, y: 2, w: 30, h: 40 }
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
    '..%2fconfig',
    '%2e%2e',
    '/etc/passwd',
    'C:\\Windows',
    'con.json',
    null,
    42
  ])('rejects id %s', (id) => {
    expect(isValidGuideId(id)).toBe(false)
    expect(guidePath(id)).toBeNull()
  })

  // Windows device names pass the id pattern; on Windows 10 'con.json' opens the console
  // device instead of a file. See 10-quality/tasks.md Notes.
  it.fails.each(['con', 'nul', 'aux', 'prn', 'com1', 'lpt1'])('rejects reserved name %s', (id) => {
    expect(isValidGuideId(id)).toBe(false)
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

describe('legacy guide files', () => {
  it('migrates array bboxes to Rect on load', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const store = await import('../src/main/guides/store')
    const dir = mkdtempSync(join(tmpdir(), 'lumen-guides-'))
    store.setGuidesDir(dir)
    const file = join(dir, 'old-guide.json')
    writeFileSync(
      file,
      JSON.stringify({
        id: 'old-guide',
        name: 'old',
        task: 't',
        createdAt: 1,
        steps: [{ label: 'a', target_hint: '', bbox: [10, 20, 110, 60] }]
      })
    )
    const g = store.loadSavedGuide('old-guide')
    expect(g?.steps[0].bbox).toEqual({ x: 10, y: 20, w: 100, h: 40 })
    expect(JSON.parse(readFileSync(file, 'utf8')).steps[0].bbox).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 40
    })
    store.setGuidesDir(null)
  })
})
