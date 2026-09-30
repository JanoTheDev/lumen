import { describe, it, expect } from 'vitest'
import {
  assertSafeUrl,
  isSafeUrl,
  classifyHotkey,
  classifyType,
  checkAction,
  normalizeCombo,
  isShellWindow,
} from '../src/main/actions/safety'

describe('assertSafeUrl', () => {
  it.each([
    'file:///C:/Windows/System32/calc.exe',
    '\\\\host\\share\\x.exe',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
    'ms-settings:privacy',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://user:pass@evil.com/',
    'C:\\Windows\\notepad.exe',
    'vbscript:msgbox',
    '',
    42,
  ])('rejects %s', (u) => {
    expect(() => assertSafeUrl(u)).toThrow()
    expect(isSafeUrl(u)).toBe(false)
  })

  it.each(['https://mail.google.com', 'http://example.com/a?b=c', 'https://www.google.com/search?q=weather+in+Larnaca'])(
    'allows %s',
    (u) => {
      expect(isSafeUrl(u)).toBe(true)
    }
  )

  it('returns a normalized URL', () => {
    expect(assertSafeUrl('  https://mail.google.com  ')).toBe('https://mail.google.com/')
  })
})

describe('normalizeCombo', () => {
  it('orders modifiers and maps aliases', () => {
    expect(normalizeCombo(['Shift', 'Control', 'Escape'])).toBe('ctrl+shift+esc')
    expect(normalizeCombo('Windows+R')).toBe('win+r')
  })
})

describe('classifyHotkey', () => {
  it.each([
    [['win', 'r'], 'deny'],
    [['win', 'x'], 'deny'],
    [['ctrl', 'alt', 'delete'], 'deny'],
    [['alt', 'f4'], 'deny'],
    [['win'], 'deny'],
    [['win', 's'], 'deny'],
    [['win', 'd'], 'confirm'],
    [['win', 'e'], 'confirm'],
    [['ctrl', 'w'], 'confirm'],
    [['ctrl', 'shift', 'esc'], 'confirm'],
    [['ctrl', 'c'], 'allow'],
    [['enter'], 'allow'],
    [['pagedown'], 'allow'],
  ])('%j → %s', (keys, verdict) => {
    expect(classifyHotkey(keys as string[])).toBe(verdict)
  })

  it('alt+f4 allowed on a Lumen window', () => {
    expect(classifyHotkey(['alt', 'f4'], { windowTitle: 'Lumen Settings' })).toBe('allow')
  })

  it('enter after typing into a shell needs confirmation', () => {
    expect(classifyHotkey(['enter'], { windowTitle: 'Windows PowerShell', afterType: true })).toBe('confirm')
    expect(classifyHotkey(['enter'], { windowTitle: 'Run', afterType: true })).toBe('confirm')
    expect(classifyHotkey(['enter'], { windowTitle: 'Untitled - Notepad', afterType: true })).toBe('allow')
  })
})

describe('isShellWindow', () => {
  it.each([
    ['Run', true],
    ['Command Prompt', true],
    ['Administrator: Windows PowerShell', true],
    ['C:\\WINDOWS\\system32\\cmd.exe', true],
    ['How to run a marathon - Google Chrome', false],
    ['PowerShell docs - Microsoft\u200b Edge', false],
    ['Inbox - Gmail - Google Chrome', false],
  ])('%s → %s', (title, expected) => {
    expect(isShellWindow(title)).toBe(expected)
  })
})

describe('checkAction', () => {
  it('denies unsafe open_url and navigate_url', () => {
    expect(checkAction({ type: 'open_url', url: 'file:///C:/x.exe' }).verdict).toBe('deny')
    expect(checkAction({ type: 'navigate_url', url: 'javascript:alert(1)' }).verdict).toBe('deny')
    expect(checkAction({ type: 'open_url', url: 'https://youtube.com' }).verdict).toBe('allow')
  })

  it('checks typing against the target window', () => {
    expect(classifyType({ windowTitle: 'Command Prompt' })).toBe('confirm')
    expect(checkAction({ type: 'type', text: 'hi' }, { windowTitle: 'Untitled - Notepad' }).verdict).toBe('allow')
  })

  it('allows unrelated actions', () => {
    expect(checkAction({ type: 'scroll' }).verdict).toBe('allow')
  })
})
