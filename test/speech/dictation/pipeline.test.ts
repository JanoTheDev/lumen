// dictate() end to end with the agent, bar and stores faked: the order backtrack → cleanup →
// format → style → insert, the recorder report (with the recording length), snippets and
// the scratchpad when no text field has focus.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const h = vi.hoisted(() => ({
  focus: {} as Record<string, unknown>,
  executed: [] as unknown[],
  notes: [] as unknown[],
  snippets: [] as unknown[],
  dictation: {} as Record<string, unknown>,
  claude: [] as string[],
  session: true
}))

vi.mock('../../../src/main/claude-code', () => ({
  focusedProject: () => undefined,
  projectForTitle: () => undefined,
  sendDictation: (text: string) => {
    if (!h.session) return { ok: false, notice: 'No Claude session is open.' }
    h.claude.push(text)
    return { ok: true, notice: 'Sent to Claude in lumen.' }
  }
}))

vi.mock('../../../src/main/windows/assistant', () => ({
  setStatus: vi.fn(),
  showAnswer: vi.fn(),
  setNotice: vi.fn(),
  setUndoHandler: vi.fn(),
  settle: vi.fn()
}))
vi.mock('../../../src/main/agent/escape', () => ({
  armEscape: vi.fn(),
  disarmEscape: vi.fn(),
  holdEscape: vi.fn(),
  keepEscapeWhile: vi.fn()
}))
vi.mock('../../../src/main/ipc/settings', () => ({ patchConfig: vi.fn() }))
vi.mock('../../../src/main/speech/dictation/learn-watch', () => ({ watchCorrections: vi.fn() }))
vi.mock('../../../src/main/speech/dictation/recovery', () => ({
  savePending: vi.fn(() => 'p1'),
  clearPending: vi.fn(),
  archivePending: vi.fn(),
  recoveryMessage: vi.fn(),
  takeRecoverable: vi.fn(() => [])
}))
vi.mock('../../../src/main/speech/dictation/notes', () => ({
  addNote: vi.fn((n: unknown) => h.notes.push(n)),
  handleNoteCommand: vi.fn(async () => false)
}))
vi.mock('../../../src/main/speech/dictation/snippets', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/speech/dictation/snippets')>()),
  loadSnippets: () => h.snippets
}))
vi.mock('../../../src/main/agent/instance', () => ({
  getAgent: () => ({
    request: async (cmd: string) => (cmd === 'focus_info' ? h.focus : { source: 'none', text: '' }),
    execute: async (a: unknown) => {
      h.executed.push(a)
    },
    activeWindow: async () => ''
  })
}))
vi.mock('../../../src/main/config', async (orig) => {
  const real = await orig<typeof import('../../../src/main/config')>()
  return {
    ...real,
    loadConfig: () => {
      const cfg = real.loadConfig()
      return { ...cfg, dictation: { ...cfg.dictation, cleanup: 'off', ...h.dictation } }
    }
  }
})

import { bus } from '../../../src/main/bus'
import {
  dictate,
  setDictationRecorder,
  SCRATCHPAD_NOTICE,
  type DictationReport
} from '../../../src/main/speech/dictation/pipeline'

const reports: DictationReport[] = []

beforeEach(() => {
  h.focus = {
    process: 'winword.exe',
    title: 'Doc',
    uia: true,
    role: 'Document',
    editable: true,
    valueTail: ''
  }
  h.executed.length = 0
  h.notes.length = 0
  h.snippets = []
  h.dictation = {}
  h.claude.length = 0
  h.session = true
  reports.length = 0
  setDictationRecorder((r) => reports.push(r))
})

describe('dictate', () => {
  it('corrects, formats and styles before typing, and reports the recording length', async () => {
    bus.emit({ type: 'dictation.started' })
    await new Promise((r) => setTimeout(r, 350))
    bus.emit({ type: 'voice.stopped' })
    const res = await dictate('it costs twenty dollars, actually thirty dollars')
    expect(res.ok).toBe(true)
    expect(h.executed).toEqual([{ type: 'type', text: 'it costs $30.', allowTerminal: false }])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ source: 'hotkey', ok: true, style: 'formal' })
    expect(reports[0].durationMs).toBeGreaterThanOrEqual(300)
  })

  it('expands a snippet instead of typing the words', async () => {
    h.snippets = [{ id: 'a', trigger: 'my calendar link', text: 'https://cal.example/me' }]
    await dictate('insert my calendar link')
    expect(h.executed).toEqual([
      { type: 'type', text: 'https://cal.example/me', allowTerminal: false }
    ])
    expect(reports[0]).toMatchObject({ source: 'snippet', text: 'https://cal.example/me' })
  })

  it('keeps the dictation as a note when no text field has focus', async () => {
    h.focus = { process: 'explorer.exe', title: 'Downloads', uia: true, role: 'listitem' }
    const res = await dictate('buy milk on the way home')
    expect(res).toEqual({ ok: true, notice: SCRATCHPAD_NOTICE })
    expect(h.executed).toEqual([])
    expect(h.notes).toEqual([
      { text: 'buy milk on the way home', via: 'scratchpad', source: { app: 'explorer.exe' } }
    ])
    expect(reports[0]).toMatchObject({ ok: false, source: 'hotkey' })
    expect(reports[0].durationMs).toBeUndefined()
  })

  it('says nothing is left after "scratch that"', async () => {
    const res = await dictate('send the file to Bob scratch that')
    expect(res.ok).toBe(true)
    expect(h.executed).toEqual([])
  })

  it('applies spell-as rules and the focused app terms (T39)', async () => {
    h.dictation = {
      spellAs: [{ from: 'cube control', to: 'kubectl' }],
      appDictionary: { winword: ['Acme Cloud'] }
    }
    // Cleanup is off in these tests, so the sentence start stays lowercase.
    await dictate('run cube control on acme cloud')
    expect(h.executed).toEqual([
      { type: 'type', text: 'run kubectl on Acme Cloud.', allowTerminal: false }
    ])
  })

  it('writes code in a code editor (T42)', async () => {
    h.focus = { ...h.focus, process: 'code.exe', title: 'app.ts - demo - Visual Studio Code' }
    await dictate('rename camel case user name to snake case account id')
    expect(h.executed).toEqual([
      { type: 'type', text: 'rename userName to account_id', allowTerminal: false }
    ])
  })

  it('tags a spoken file name in a code editor (T42)', async () => {
    h.focus = { ...h.focus, process: 'cursor.exe', title: 'app.ts - demo - Cursor' }
    await dictate('look at file app dot ts')
    expect(h.executed).toEqual([{ type: 'type', text: 'look @app.ts', allowTerminal: false }])
  })

  it('leaves code words alone with coding mode off', async () => {
    h.focus = { ...h.focus, process: 'code.exe', title: 'app.ts' }
    h.dictation = { codingMode: false }
    await dictate('config dot json')
    expect(h.executed).toEqual([{ type: 'type', text: 'config dot json', allowTerminal: false }])
  })

  it('sends "to Claude, …" to the Claude Code session instead of typing (T42)', async () => {
    const res = await dictate('to Claude, fix camel case get user in at file user dot ts')
    expect(res).toEqual({ ok: true, notice: 'Sent to Claude in lumen.' })
    expect(h.claude).toEqual(['fix getUser in @user.ts'])
    expect(h.executed).toEqual([])
    expect(reports[0]).toMatchObject({ app: 'claude-code', ok: true })
  })

  it('keeps the text when no Claude session is open', async () => {
    h.session = false
    const res = await dictate('dictate to Claude add a test')
    expect(res.ok).toBe(false)
    expect(h.executed).toEqual([])
  })
})
