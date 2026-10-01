import { describe, expect, it, vi } from 'vitest'
import {
  flattenForTerminal,
  guardText,
  isTerminalTarget,
  TERMINAL_NOTICE,
  type FocusTarget
} from '../../src/main/speech/dictation/terminal-guard'
import { insertDictation, withJoiningSpace } from '../../src/main/speech/dictation/insert'
import type { AgentBridge } from '../../src/main/agent/bridge'

function target(over: Partial<FocusTarget> = {}): FocusTarget {
  return {
    process: 'notepad.exe',
    title: 'Untitled - Notepad',
    uia: true,
    role: 'edit',
    name: 'Text editor',
    editable: true,
    password: false,
    valueTail: '',
    ...over
  }
}

describe('isTerminalTarget', () => {
  it.each([
    'windowsterminal.exe',
    'wt.exe',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'conhost.exe',
    'wsl.exe',
    'mintty.exe',
    'alacritty.exe',
    'wezterm-gui.exe',
    'WindowsTerminal.exe'
  ])('%s is a terminal', (process) => {
    expect(isTerminalTarget(target({ process }))).toBe(true)
  })

  it('detects the VS Code integrated terminal by the focused element', () => {
    expect(isTerminalTarget(target({ process: 'code.exe', name: 'Terminal 1, pwsh' }))).toBe(true)
    expect(isTerminalTarget(target({ process: 'code.exe', name: 'Editor content' }))).toBe(false)
  })

  it('falls back to the window title when the process is unknown', () => {
    expect(isTerminalTarget(target({ process: '', title: 'Windows PowerShell' }))).toBe(true)
    expect(
      isTerminalTarget(target({ process: '', title: 'PowerShell tips - Google Chrome' }))
    ).toBe(false)
  })

  it('normal apps are not terminals', () => {
    expect(isTerminalTarget(target())).toBe(false)
    expect(isTerminalTarget(target({ process: 'chrome.exe', title: 'cmd tutorial' }))).toBe(false)
  })
})

describe('guardText', () => {
  it('never leaves a line break (Enter) in terminal text', () => {
    const d = guardText('git status\nrm -rf /\r\n', target({ process: 'cmd.exe' }), 'type-no-enter')
    expect(d).toEqual({
      kind: 'type',
      text: 'git status rm -rf /',
      terminal: true,
      notice: TERMINAL_NOTICE
    })
    expect(flattenForTerminal('a b\u0007c\n')).toBe('a bc')
  })

  it('blocks terminals when the policy says so', () => {
    expect(guardText('hello', target({ process: 'pwsh.exe' }), 'block').kind).toBe('block')
  })

  it('keeps line breaks in normal fields', () => {
    expect(guardText('a\nb', target(), 'block')).toEqual({
      kind: 'type',
      text: 'a\nb',
      terminal: false
    })
  })
})

describe('insertDictation', () => {
  function agent(): { execute: ReturnType<typeof vi.fn>; bridge: AgentBridge } {
    const execute = vi.fn(async () => ({}))
    return { execute, bridge: { execute } as unknown as AgentBridge }
  }

  it('types through the agent without a clipboard, and allows terminals only once flattened', async () => {
    const a = agent()
    const res = await insertDictation(
      a.bridge,
      'ls\n',
      target({ process: 'cmd.exe' }),
      'type-no-enter'
    )
    expect(res).toEqual({ ok: true, terminal: true, notice: TERMINAL_NOTICE })
    expect(a.execute).toHaveBeenCalledWith({ type: 'type', text: 'ls', allowTerminal: true })

    await insertDictation(a.bridge, 'Hi.', target(), 'type-no-enter')
    expect(a.execute).toHaveBeenLastCalledWith({ type: 'type', text: 'Hi.', allowTerminal: false })
  })

  it('never types into password fields or blocked terminals', async () => {
    const a = agent()
    expect(
      (await insertDictation(a.bridge, 'x', target({ password: true }), 'type-no-enter')).ok
    ).toBe(false)
    expect((await insertDictation(a.bridge, 'x', target({ process: 'wt.exe' }), 'block')).ok).toBe(
      false
    )
    expect(a.execute).not.toHaveBeenCalled()
  })

  it('reports an agent refusal instead of throwing', async () => {
    const execute = vi.fn(async () => {
      throw new Error('type denied: target is a terminal')
    })
    const res = await insertDictation({ execute } as unknown as AgentBridge, 'x', target(), 'block')
    expect(res.ok).toBe(false)
  })

  it('adds a joining space only when the text would glue onto a word', () => {
    expect(withJoiningSpace('Next.', 'Done.')).toBe(' Next.')
    expect(withJoiningSpace('Next.', 'Done. ')).toBe('Next.')
    expect(withJoiningSpace(', then', 'a')).toBe(', then')
    expect(withJoiningSpace('Hi', '')).toBe('Hi')
  })
})
