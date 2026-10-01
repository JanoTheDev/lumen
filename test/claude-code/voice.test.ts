import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeProject, ClaudeSessionView } from '@shared/claude-code'
import { matchClaudeCodeIntent } from '../../src/main/claude-code/intents'
import {
  cwdFromTranscript,
  decodeProjectDir,
  listClaudeProjects,
  matchProject,
  mergeProjects
} from '../../src/main/claude-code/projects'
import { commandsIn, discoverCommands, matchCommand } from '../../src/main/claude-code/commands'
import {
  correctionTurn,
  decisionPrompt,
  detectQuestion,
  shouldAutoAnswer
} from '../../src/main/claude-code/autopilot'
import { buildArgs, command } from '../../src/main/claude-code/cli'
import { taskPhase, toBackgroundTask } from '../../src/main/claude-code/background'

describe('matchClaudeCodeIntent', () => {
  it.each([
    ['Open lumen in Claude.', { kind: 'open', project: 'lumen' }],
    ['start Claude on the ai overlay project', { kind: 'open', project: 'ai overlay project' }],
    [
      'open the jogy repo in claude code and fix the tests',
      { kind: 'open', project: 'jogy repo', prompt: 'fix the tests' }
    ],
    ['Tell Claude to run the code review', { kind: 'tell', text: 'run the code review' }],
    ['Claude, simplify this.', { kind: 'tell', text: 'simplify this' }],
    ["What's Claude doing?", { kind: 'status' }],
    ['what is claude code up to', { kind: 'status' }],
    ['read me the last answer', { kind: 'read-last' }],
    ['Approve', { kind: 'permission', answer: 'once' }],
    ['always allow this', { kind: 'permission', answer: 'always' }],
    ['deny it', { kind: 'permission', answer: 'deny' }],
    ['Answer: use spaces', { kind: 'answer', text: 'use spaces' }],
    ['stop Claude', { kind: 'stop' }],
    ['autopilot on', { kind: 'autopilot', level: 'full' }],
    ['autopilot careful', { kind: 'autopilot', level: 'careful' }],
    ['pause autopilot', { kind: 'autopilot', level: 'off' }],
    ['undo that answer', { kind: 'undo-answer' }]
  ])('%s', (text, intent) => {
    expect(matchClaudeCodeIntent(text)).toEqual(intent)
  })

  it('ignores everything else', () => {
    for (const t of ['open notepad', 'what is the weather', 'stop', 'tell me a joke', ''])
      expect(matchClaudeCodeIntent(t), t).toBeNull()
  })
})

describe('project registry', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'lumen-cc-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the real folder from the newest transcript', () => {
    const real = join(dir, 'My Projects', 'ai-overlay')
    mkdirSync(real, { recursive: true })
    const projects = join(dir, 'projects')
    const sub = join(projects, 'C--whatever-My-Projects-ai-overlay')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'old.jsonl'), `${JSON.stringify({ cwd: 'C:\\gone' })}\n`)
    utimesSync(join(sub, 'old.jsonl'), 1, 1)
    writeFileSync(join(sub, 'new.jsonl'), `{"type":"mode"}\n${JSON.stringify({ cwd: real })}\n`)
    const list = listClaudeProjects(projects, () => false)
    expect(list).toEqual([
      expect.objectContaining({ path: real, name: 'ai-overlay', source: 'claude' })
    ])
  })

  it('decodes a lossy folder name by walking the disk', () => {
    const real = new Set([
      'C:\\Users',
      'C:\\Users\\me',
      'C:\\Users\\me\\Random Projects',
      'C:\\Users\\me\\Random Projects\\ai-overlay'
    ])
    expect(
      decodeProjectDir('C--Users-me-Random-Projects-ai-overlay', (p) => real.has(String(p)))
    ).toBe('C:\\Users\\me\\Random Projects\\ai-overlay')
    expect(decodeProjectDir('nope', () => true)).toBeNull()
    expect(cwdFromTranscript('garbage\n{"cwd":"D:\\\\x"}\n')).toBe('D:\\x')
  })

  it('matches spoken names', () => {
    const ps: ClaudeProject[] = [
      { path: 'C:\\p\\ai-overlay', name: 'ai-overlay', source: 'claude' },
      { path: 'C:\\p\\Jogy', name: 'Jogy', source: 'claude' },
      { path: 'C:\\p\\lumen-site', name: 'lumen-site', source: 'claude' }
    ]
    expect(matchProject('the ai overlay project', ps)?.name).toBe('ai-overlay')
    expect(matchProject('jogi', ps)?.name).toBe('Jogy')
    expect(matchProject('lumen', ps)?.name).toBe('lumen-site')
    expect(matchProject('banana', ps)).toBeNull()
    const named = mergeProjects(ps, [{ path: 'C:\\p\\ai-overlay', name: 'Lumen' }])
    expect(matchProject('lumen', named)?.path).toBe('C:\\p\\ai-overlay')
    expect(mergeProjects([], [{ path: 'D:\\x' }])[0]).toMatchObject({ source: 'user', name: 'x' })
  })
})

describe('commands', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'lumen-cc-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds commands, skills and plugin commands', () => {
    const proj = join(dir, 'proj')
    mkdirSync(join(proj, '.claude', 'commands', 'ops'), { recursive: true })
    writeFileSync(
      join(proj, '.claude', 'commands', 'ops', 'deploy-check.md'),
      '---\ndescription: Checks\n---\n'
    )
    mkdirSync(join(proj, '.claude', 'skills', 'tidy'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy-up\n---\n')
    const home = join(dir, 'home')
    const plug = join(dir, 'plug')
    mkdirSync(join(plug, 'commands'), { recursive: true })
    writeFileSync(join(plug, 'commands', 'caveman-commit.md'), 'x')
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'caveman@market': [{ installPath: plug }] } })
    )
    const cmds = discoverCommands(proj, ['/code-review', 'tidy-up'], home)
    expect(cmds.map((c) => c.name)).toEqual([
      'deploy-check',
      'tidy-up',
      'caveman:caveman-commit',
      'code-review'
    ])
    expect(commandsIn(join(proj, '.claude'), 'project')[0].description).toBe('Checks')
    expect(matchCommand('the code review', cmds)?.name).toBe('code-review')
    expect(matchCommand('review', cmds)?.name).toBe('code-review')
    expect(matchCommand('deploy check', cmds)?.name).toBe('deploy-check')
    expect(matchCommand('caveman commit', cmds)?.name).toBe('caveman:caveman-commit')
    expect(matchCommand('make coffee', cmds)).toBeNull()
  })
})

describe('autopilot', () => {
  it('finds the question at the end of a turn', () => {
    expect(detectQuestion('All tests pass.')).toBeNull()
    const q = detectQuestion(
      'Two ways:\n\n1. Keep it\n2. Remove it (Recommended)\n\nWhich one should I use?'
    )
    expect(q?.options).toEqual(['Keep it', 'Remove it (Recommended)'])
    expect(detectQuestion('Done. Let me know if you want more changes')).not.toBeNull()
  })

  it('answers only when the level and confidence allow', () => {
    const d = { answer: 'yes', confidence: 0.7, reason: 'because', stakes: 'low' as const }
    expect(shouldAutoAnswer('off', { ...d, confidence: 1 }, 0.8)).toBe(false)
    expect(shouldAutoAnswer('careful', d, 0.8)).toBe(false)
    expect(shouldAutoAnswer('careful', { ...d, confidence: 0.9 }, 0.8)).toBe(true)
    expect(shouldAutoAnswer('full', d, 0.8)).toBe(true)
    expect(shouldAutoAnswer('full', { ...d, stakes: 'high', confidence: 1 }, 0.8)).toBe(false)
  })

  it('builds the decision prompt and the correction', () => {
    const p = decisionPrompt({
      question: { question: 'Tabs?', options: ['a'] },
      claudeMd: 'Spaces',
      recent: ['fix it']
    })
    expect(p).toContain('<claude_question>\nTabs?')
    expect(p).toContain('<claude_md>\nSpaces')
    expect(correctionTurn('tabs', 'Tabs?')).toContain('disregard my previous answer ("tabs")')
  })
})

describe('cli', () => {
  it('never builds a bypass command line and refuses shell tricks', () => {
    const a = buildArgs({
      resume: 'abc-123',
      model: 'sonnet',
      allowedTools: ['Bash(npm test *)', 'Edit']
    })
    expect(a).toEqual(
      expect.arrayContaining(['--resume', 'abc-123', '--allowedTools', 'Bash(npm test *),Edit'])
    )
    expect(() => buildArgs({ model: 'x & calc' })).toThrow(/refused/)
    expect(() => buildArgs({ allowedTools: ['bypassPermissions'] })).toThrow(/refused/)
  })

  it('runs a .cmd shim through cmd.exe', () => {
    expect(command('C:\\a\\claude.exe', ['-p'])).toEqual({
      file: 'C:\\a\\claude.exe',
      args: ['-p'],
      verbatim: false
    })
    const c = command('C:\\Program Files\\npm\\claude.cmd', ['-p', '--settings', 'C:\\x y\\s.json'])
    expect(c.file).toBe('cmd.exe')
    expect(c.args[3]).toBe('""C:\\Program Files\\npm\\claude.cmd" -p --settings "C:\\x y\\s.json""')
  })
})

describe('background adapter', () => {
  it('maps a session to a background task', () => {
    const v: ClaudeSessionView = {
      id: 'cc_x1234',
      project: 'C:\\p',
      projectName: 'p',
      title: 'p: fix',
      phase: 'idle',
      lastLine: 'All good',
      lastAnswer: 'All good, tests pass',
      costUsd: 0.2,
      turns: 2,
      startedAt: 5,
      lastActive: 9,
      autopilot: 'careful',
      autoAnswers: [],
      commands: []
    }
    expect(toBackgroundTask(v)).toMatchObject({
      phase: 'done',
      title: 'Claude: p: fix',
      result: { summary: 'All good, tests pass' },
      counters: { costUsd: 0.2 }
    })
    expect(taskPhase({ ...v, phase: 'running-tool' })).toBe('running')
    expect(taskPhase({ ...v, pending: { kind: 'question', text: '?' } })).toBe('asking')
  })
})
