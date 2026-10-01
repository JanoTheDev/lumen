// Registrar-level IPC validation: a bad payload (wrong type, oversize, extra keys) returns
// { error: 'E_INVALID' } (or the channel's documented empty reply) and the handler body, i.e.
// the injected dependency, never runs. Schema-only checks are in ipc-validation.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())
vi.mock('../src/main/windows/registry', () => ({ applyUiScale: vi.fn(), broadcast: vi.fn() }))
vi.mock('../src/main/windows/status', () => ({ hideStatus: vi.fn(), setStatus: vi.fn() }))
vi.mock('../src/main/windows/settings', () => ({}))
vi.mock('../src/main/windows/assistant', () => ({
  consumeDenied: vi.fn(() => false),
  requestConfirm: vi.fn(async () => false),
  turnEnded: vi.fn(),
  settle: vi.fn(),
  open: vi.fn()
}))
vi.mock('../src/main/actions/executor', () => ({ executeActions: vi.fn(async () => ({})) }))
vi.mock('../src/main/agent/escape', () => ({ armEscape: vi.fn(), disarmEscape: vi.fn() }))
vi.mock('../src/main/a11y/transcript', () => ({
  beforeUtterance: vi.fn((prompt: string) => ({ prompt })),
  confirmBatch: vi.fn(async () => ({ ok: true, approved: false })),
  explainBeforeDo: vi.fn(async () => {})
}))
vi.mock('../src/main/agent-mode/confirm', () => ({
  answerAlways: vi.fn(() => false),
  confirmAlways: vi.fn(() => false),
  lastUserRequest: vi.fn(() => '')
}))
vi.mock('../src/main/agent-mode/session', () => ({
  agentRunning: vi.fn(() => false),
  interceptAgentUtterance: vi.fn(() => false)
}))
vi.mock('../src/main/speech/router-hook', () => ({ prepareVoiceText: (s: string) => s }))
vi.mock('../src/main/speech/hotkey', () => ({
  onRecordingEnded: vi.fn(),
  onSpeakingChanged: vi.fn(),
  onTurnEnded: vi.fn()
}))
vi.mock('../src/main/speech/stt', () => ({ prepareStt: vi.fn(), sttStatus: vi.fn() }))
vi.mock('../src/main/speech/stt/local-model', () => ({ installLocalModel: vi.fn() }))
vi.mock('../src/main/speech/wake', () => ({ onWakePcm: vi.fn(), wakeFeedWanted: vi.fn() }))
vi.mock('../src/main/speech/wake/handlers', () => ({ handleBargeIn: vi.fn() }))
vi.mock('../src/main/guides/store', () => ({
  listSavedGuides: vi.fn(() => []),
  deleteSavedGuide: vi.fn(() => true)
}))

import { electronMock, emitIpc, invokeHandler, resetElectronMock } from './helpers/electron-mock'
import { tempDir } from './helpers/fixtures'
import { registerSettingsIpc } from '../src/main/ipc/settings'
import { registerGuidesIpc } from '../src/main/ipc/guides'
import { registerVoiceIpc } from '../src/main/ipc/voice'
import { registerHudIpc } from '../src/main/ipc/hud'
import { registerQueryIpc } from '../src/main/ipc/query'
import { invalidateConfig, loadConfig, setConfigDir } from '../src/main/config'
import { executeActions } from '../src/main/actions/executor'
import { deleteSavedGuide } from '../src/main/guides/store'

const INVALID = { error: 'E_INVALID' }
const big = (n: number): string => 'a'.repeat(n)

let tmp: ReturnType<typeof tempDir>

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  tmp = tempDir()
  setConfigDir(tmp.dir)
  invalidateConfig()
  resetElectronMock()
  vi.mocked(executeActions).mockClear()
  vi.mocked(deleteSavedGuide).mockClear()
})
afterEach(() => {
  tmp.cleanup()
  vi.restoreAllMocks()
})

describe('settings:patch', () => {
  const deps = {
    setHotkey: vi.fn(async () => {}),
    applyDictationHotkey: vi.fn(async () => {}),
    applyListenerState: vi.fn(),
    applyDwellState: vi.fn()
  }
  beforeEach(() => {
    for (const fn of Object.values(deps)) fn.mockClear()
    registerSettingsIpc(deps)
  })

  it.each([
    'Ctrl+Shift+Space; calc.exe',
    'Ctrl+Shift+Space\n',
    'Ctrl+Shift+Space && del /q *',
    '$(calc)',
    'Ctrl+`calc`',
    'Ctrl+Shift+Space"',
    big(5000),
    'Ctrl+Shift+Space\u0000x'
  ])('a malicious hotkey %j never reaches setHotkey or the file', async (hotkey) => {
    const before = loadConfig().hotkey
    await expect(invokeHandler('settings:patch', { hotkey })).resolves.toEqual(INVALID)
    expect(deps.setHotkey).not.toHaveBeenCalled()
    invalidateConfig()
    expect(loadConfig().hotkey).toBe(before)
  })

  it.each([
    ['wrong type', { hotkey: 42 }],
    ['extra key', { hotkey: 'Ctrl+Alt+K', evil: true }],
    ['extra nested key', { voice: { tts: 'off', shell: 'calc' } }],
    ['array', [{ hotkey: 'Ctrl+Alt+K' }]],
    ['null', null],
    ['oversize phrase', { wakeWord: { phrase: big(100_000) } }]
  ])('%s → E_INVALID with no side effects', async (_name, patch) => {
    await expect(invokeHandler('settings:patch', patch)).resolves.toEqual(INVALID)
    for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled()
  })

  it('a valid hotkey still goes through', async () => {
    await invokeHandler('settings:patch', { hotkey: 'Ctrl+Alt+K' })
    expect(deps.setHotkey).toHaveBeenCalledWith('Ctrl+Alt+K')
  })

  it.each([['not-a-profile'], 'motor-pointer', [1], null])(
    'a11y:apply-profile rejects %j',
    async (ids) => {
      await expect(invokeHandler('a11y:apply-profile', ids)).resolves.toEqual(INVALID)
      expect(deps.applyDwellState).not.toHaveBeenCalled()
    }
  )
})

describe('guides', () => {
  const deps = { saveLast: vi.fn(() => null), replay: vi.fn(() => null) }
  beforeEach(() => {
    deps.saveLast.mockClear()
    deps.replay.mockClear()
    registerGuidesIpc(deps)
  })

  it.each([
    '../config',
    '..%2fconfig',
    '..\\config',
    'C:\\Windows\\x',
    '/etc/passwd',
    'UPPER',
    big(65),
    42,
    null,
    { id: 'x' }
  ])('replay and delete refuse id %j', async (id) => {
    await expect(invokeHandler('guides:replay', id)).resolves.toEqual({ error: 'not found' })
    await expect(invokeHandler('guides:delete', id)).resolves.toEqual({ ok: false })
    expect(deps.replay).not.toHaveBeenCalled()
    expect(deleteSavedGuide).not.toHaveBeenCalled()
  })

  it('save-last with an invalid name does not save', async () => {
    await expect(invokeHandler('guides:save-last', { name: 'x' })).resolves.toEqual(INVALID)
    await expect(invokeHandler('guides:save-last', big(81))).resolves.toEqual(INVALID)
    await expect(invokeHandler('guides:save-last', 42)).resolves.toEqual(INVALID)
    expect(deps.saveLast).not.toHaveBeenCalled()
  })

  it('save-last without a name still saves', async () => {
    await invokeHandler('guides:save-last')
    expect(deps.saveLast).toHaveBeenCalledWith('')
  })
})

describe('voice', () => {
  const deps = {
    speak: vi.fn(async () => {}),
    transcribe: vi.fn(async () => 'hi'),
    dictate: vi.fn(async () => ({ ok: true }))
  }
  beforeEach(() => {
    for (const fn of Object.values(deps)) fn.mockClear()
    registerVoiceIpc(deps)
  })

  it.each([42, { text: 'hi' }, big(20_001), null])('voice:speak rejects %j', async (raw) => {
    await expect(invokeHandler('voice:speak', raw)).resolves.toEqual(INVALID)
    expect(deps.speak).not.toHaveBeenCalled()
  })

  it.each([42, { text: 'hi' }, big(20_001)])('voice:dictate rejects %j', async (raw) => {
    await expect(invokeHandler('voice:dictate', raw)).resolves.toEqual(INVALID)
    expect(deps.dictate).not.toHaveBeenCalled()
  })

  it.each(['audio', 42, null, new ArrayBuffer(30 * 1024 * 1024)])(
    'voice:transcribe ignores %#',
    async (raw) => {
      await expect(invokeHandler('voice:transcribe', raw)).resolves.toBe('')
      expect(deps.transcribe).not.toHaveBeenCalled()
    }
  )

  it('voice:transcribe drops unknown option keys', async () => {
    await invokeHandler('voice:transcribe', new ArrayBuffer(8), { dictation: true, x: 1 })
    expect(deps.transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), {})
  })
})

describe('assistant:open-link', () => {
  beforeEach(() => registerHudIpc({ armEscape: vi.fn(), disarmEscape: vi.fn() }))

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    '\\\\evil\\share\\x.exe',
    'ms-msdt:/id x',
    42,
    null
  ])('never opens %j', (url) => {
    emitIpc('assistant:open-link', url)
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled()
  })

  it('opens an https link, normalized', () => {
    emitIpc('assistant:open-link', ' https://example.com ')
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith('https://example.com/')
  })
})

describe('assistant:query / assistant:execute', () => {
  const deps = { intercept: vi.fn(() => undefined), runQuery: vi.fn() }
  beforeEach(() => {
    deps.intercept.mockClear()
    deps.runQuery.mockClear()
    registerQueryIpc(deps)
  })

  it.each([
    ['', undefined],
    ['   ', undefined],
    [big(4001), undefined],
    [42, undefined],
    [null, undefined],
    [{ q: 'hi' }, undefined]
  ])('query %#: rejects a bad prompt before routing', async (prompt, opts) => {
    await expect(invokeHandler('assistant:query', prompt, opts)).resolves.toEqual(INVALID)
    expect(deps.intercept).not.toHaveBeenCalled()
    expect(deps.runQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['not an array', { type: 'click', x: 1, y: 2 }],
    ['unknown action', [{ type: 'run_shell', cmd: 'calc' }]],
    ['wrong field type', [{ type: 'click', x: 'a', y: 2 }]],
    ['oversize text', [{ type: 'type', text: big(100_000) }]],
    ['null', null]
  ])('execute: %s → E_INVALID, nothing runs', async (_name, actions) => {
    await expect(invokeHandler('assistant:execute', actions)).resolves.toEqual(INVALID)
    expect(executeActions).not.toHaveBeenCalled()
  })

  it('execute: unknown keys are stripped before the executor sees them', async () => {
    await invokeHandler('assistant:execute', [{ type: 'click', x: 1, y: 2, shell: 'calc' }])
    const sent = vi.mocked(executeActions).mock.calls[0][0][0]
    expect(sent).not.toHaveProperty('shell')
  })

  it('execute: a valid batch reaches the executor as user-direct', async () => {
    await invokeHandler('assistant:execute', [{ type: 'scroll', direction: 'down' }])
    expect(executeActions).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'scroll' })],
      expect.objectContaining({ origin: 'user-direct' })
    )
  })

  it('execute: approved comes from the card the user answered, not from config (review high)', async () => {
    const { confirmBatch } = await import('../src/main/a11y/transcript')
    await invokeHandler('assistant:execute', [{ type: 'hotkey', keys: ['enter'] }])
    expect(executeActions).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ approved: false })
    )
    vi.mocked(confirmBatch).mockResolvedValueOnce({ ok: false, approved: false })
    vi.mocked(executeActions).mockClear()
    await invokeHandler('assistant:execute', [{ type: 'hotkey', keys: ['enter'] }])
    expect(executeActions).not.toHaveBeenCalled()
  })
})
