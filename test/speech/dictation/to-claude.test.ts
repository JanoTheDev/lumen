import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  listProjectFiles,
  pickFile,
  projectResolver
} from '../../../src/main/speech/dictation/file-resolve'
import {
  claudeTargetAllowed,
  matchClaudeDictation
} from '../../../src/main/speech/dictation/to-claude'
import { tempDir } from '../../helpers/fixtures'

describe('matchClaudeDictation', () => {
  it('takes the text after "to Claude"', () => {
    expect(matchClaudeDictation('To Claude, fix the failing test')).toBe('fix the failing test')
    expect(matchClaudeDictation('dictate to Claude code add a README')).toBe('add a README')
    expect(matchClaudeDictation('send this to claude: run the tests')).toBe('run the tests')
  })

  it('ignores Claude mentioned inside a sentence or with nothing after it', () => {
    expect(matchClaudeDictation('I wrote to Claude yesterday')).toBeNull()
    expect(matchClaudeDictation('to Claude')).toBeNull()
    expect(matchClaudeDictation('Claude said hi')).toBeNull()
  })
})

describe('claudeTargetAllowed (M3)', () => {
  const at = (process: string, title = ''): { process: string; title: string; name: string } => ({
    process,
    title,
    name: ''
  })
  const ctx = { sessionFocused: true, ownProcess: 'Lumen.exe' }

  it('sends from a terminal, a code editor or Lumen with a session focused', () => {
    expect(claudeTargetAllowed(at('windowsterminal.exe'), ctx)).toBe(true)
    expect(claudeTargetAllowed(at('code.exe'), ctx)).toBe(true)
    expect(claudeTargetAllowed(at('lumen.exe'), ctx)).toBe(true)
  })

  it('types it in mail, documents and browser tabs, or without a session', () => {
    expect(claudeTargetAllowed(at('outlook.exe', 'Inbox - Outlook'), ctx)).toBe(false)
    expect(claudeTargetAllowed(at('winword.exe'), ctx)).toBe(false)
    expect(claudeTargetAllowed(at('chrome.exe', 'Issue #12 · GitHub'), ctx)).toBe(false)
    expect(claudeTargetAllowed(at('code.exe'), { ...ctx, sessionFocused: false })).toBe(false)
  })
})

describe('file resolve', () => {
  const t = tempDir()
  afterAll(() => t.cleanup())
  const root = t.dir
  mkdirSync(join(root, 'src', 'main'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'src', 'main', 'pipeline.ts'), '')
  writeFileSync(join(root, 'src', 'main', 'index.ts'), '')
  writeFileSync(join(root, 'test', 'index.ts'), '')
  writeFileSync(join(root, 'node_modules', 'x', 'pipeline.ts'), '')

  it('lists project files without dependency folders', () => {
    expect(listProjectFiles(root).sort()).toEqual([
      'src/main/index.ts',
      'src/main/pipeline.ts',
      'test/index.ts'
    ])
  })

  it('resolves a unique name, or a path ending, case-insensitive', () => {
    const files = listProjectFiles(root)
    expect(pickFile('Pipeline.ts', files)).toBe('src/main/pipeline.ts')
    expect(pickFile('index.ts', files)).toBeNull()
    expect(pickFile('main/index.ts', files)).toBe('src/main/index.ts')
    expect(pickFile('missing.ts', files)).toBeNull()
  })

  it('gives no resolver without a project', () => {
    expect(projectResolver(undefined)).toBeUndefined()
    expect(projectResolver(root)?.('pipeline.ts')).toBe('src/main/pipeline.ts')
  })
})
