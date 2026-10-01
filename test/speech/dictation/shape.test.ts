import { describe, expect, it } from 'vitest'
import { shapeDictation } from '../../../src/main/speech/dictation/shape'
import type { FocusTarget } from '../../../src/main/speech/dictation/terminal-guard'

const target = (over: Partial<FocusTarget> = {}): FocusTarget => ({
  process: 'foo.exe',
  title: '',
  uia: true,
  role: 'Document',
  name: '',
  editable: true,
  password: false,
  valueTail: '',
  ...over
})
const cfg = { format: true, styles: {}, styleApps: {}, dictionary: [], codingMode: true }
const shape = (text: string, t: FocusTarget): ReturnType<typeof shapeDictation> =>
  shapeDictation({ text, source: 'model' }, t, cfg)

describe('shapeDictation line breaks (M5)', () => {
  it('uses Shift+Enter in chat apps and unknown apps', () => {
    expect(shape('Hi.\nBye.', target({ process: 'claude.exe', title: 'Claude' })).softBreaks).toBe(
      true
    )
    expect(shape('Hi.\nBye.', target({ process: 'chatgpt.exe' })).softBreaks).toBe(true)
    expect(shape('Hi.\nBye.', target({ process: 'slack.exe' })).softBreaks).toBe(true)
    expect(
      shape('Hi.\nBye.', target({ process: 'chrome.exe', title: 'LinkedIn' })).softBreaks
    ).toBe(true)
  })

  it('keeps Enter where it is a plain new line', () => {
    expect(shape('Hi.\nBye.', target({ process: 'winword.exe' })).softBreaks).toBe(false)
    expect(shape('Hi.\nBye.', target({ process: 'outlook.exe' })).softBreaks).toBe(false)
    expect(shape('Hi.\nBye.', target({ process: 'code.exe' })).softBreaks).toBe(false)
  })
})

describe('shapeDictation coding mode (M8)', () => {
  it('keeps prose on a GitHub page in a browser', () => {
    const t = target({ process: 'chrome.exe', title: 'Issue #12 · acme/app · GitHub' })
    expect(shape('this is less than ideal and equals the old behaviour', t).text).toBe(
      'this is less than ideal and equals the old behaviour'
    )
  })

  it('still writes symbols in a code editor', () => {
    const t = target({ process: 'code.exe', title: 'app.ts - demo - Visual Studio Code' })
    expect(shape('x less than y', t).text).toBe('x < y')
  })
})
