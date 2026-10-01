import { describe, expect, it, vi } from 'vitest'
import {
  canWriteBack,
  copyFallbackAllowed,
  editSummary,
  EDIT_PROMPT,
  isReplyCommand,
  isStrongEditCommand,
  looksLikeEditCommand,
  readSelection,
  rewriteSelection,
  writeBack,
  writeBackAction,
  type CommandIo,
  type SavedClipboard
} from '../../../src/main/speech/dictation/command'
import type { FocusTarget } from '../../../src/main/speech/dictation/terminal-guard'

const target = (over: Partial<FocusTarget> = {}): FocusTarget => ({
  process: 'winword.exe',
  title: 'Doc',
  uia: true,
  role: 'Document',
  name: '',
  editable: true,
  password: false,
  valueTail: '',
  ...over
})

function fakeIo(opts: { uia?: { source: string; text: string }; copied?: string } = {}): {
  io: CommandIo
  executed: unknown[]
  clip: { text: string }
} {
  const clip = { text: 'ORIGINAL' }
  const executed: unknown[] = []
  const io: CommandIo = {
    agent: {
      request: vi.fn(async () => opts.uia ?? { source: 'none', text: '' }) as never,
      execute: vi.fn(async (a: { type: string; keys?: string[] }) => {
        executed.push(a)
        if (a.type === 'hotkey' && a.keys?.join('+') === 'ctrl+c') clip.text = opts.copied ?? ''
      }) as never
    },
    clipboard: {
      save: (): SavedClipboard => ({ text: clip.text, html: '', rtf: '', image: null }),
      restore: (s) => {
        clip.text = s.text
      },
      readText: () => clip.text,
      writeText: (t) => {
        clip.text = t
      },
      clear: () => {
        clip.text = ''
      }
    },
    sleep: async () => {}
  }
  return { io, executed, clip }
}

describe('edit command phrases', () => {
  it('spots edit commands', () => {
    expect(looksLikeEditCommand('make this friendlier')).toBe(true)
    expect(looksLikeEditCommand('Translate to Spanish')).toBe(true)
    expect(looksLikeEditCommand('please shorten it')).toBe(true)
    expect(looksLikeEditCommand('I made a cake today')).toBe(false)
  })

  it('needs a strong command for the copy fallback', () => {
    expect(isStrongEditCommand('make this friendlier')).toBe(true)
    expect(isStrongEditCommand('fix the grammar')).toBe(true)
    expect(isStrongEditCommand('translate to German')).toBe(true)
    expect(isStrongEditCommand('reply to this saying I can come')).toBe(true)
    expect(isStrongEditCommand('make sure we leave early')).toBe(false)
    expect(isStrongEditCommand('change of plans we leave at six')).toBe(false)
  })

  it('reads ordinary sentences that start with an edit verb as dictation (M2)', () => {
    for (const t of [
      'Make sure everyone brings their laptop.',
      'Change of plans, we meet at noon.',
      'Make it to the station by six.',
      'Turn it off before you leave.',
      'Fix it tomorrow if you can.',
      'Put the box on the table.',
      'Format the drive before you install.',
      'Make that three tickets please.',
      'Correct me if I am wrong.',
      'Reply when you can.',
      'Expand your search.',
      'Make it happen.',
      'Make it later.',
      'Turn left at the light.',
      'More coffee.',
      'Better late than never.',
      'Improve the onboarding flow next quarter.',
      'Convert the guests into fans.',
      'Polish silver every month.'
    ]) {
      expect(looksLikeEditCommand(t), t).toBe(false)
      expect(isStrongEditCommand(t), t).toBe(false)
    }
  })

  it('still spots edits that name the selection or a style (M2)', () => {
    for (const t of [
      'make this shorter',
      'Make it a bit more formal.',
      'make this sound friendlier',
      'turn this into bullet points',
      'turn it into a numbered list',
      'make it a bulleted list',
      'shorter',
      'more formal',
      'into bullets',
      'turn into bullets',
      'fix the grammar',
      'fix this',
      'rewrite this for a customer',
      'summarize',
      'translate it to French',
      'can you make it friendlier'
    ])
      expect(looksLikeEditCommand(t), t).toBe(true)
  })

  it('knows a reply', () => {
    expect(isReplyCommand('reply to this saying yes')).toBe(true)
    expect(isReplyCommand('make it shorter')).toBe(false)
  })
})

describe('readSelection', () => {
  it('uses the UIA selection first', async () => {
    const { io, executed } = fakeIo({ uia: { source: 'selection', text: 'hello' } })
    expect(await readSelection(io, 'make it shorter', target())).toEqual({
      kind: 'selection',
      text: 'hello',
      via: 'uia'
    })
    expect(executed).toEqual([])
  })

  it('copies with Ctrl+C for a strong command and restores the clipboard', async () => {
    const { io, executed, clip } = fakeIo({ copied: 'copied text' })
    const r = await readSelection(io, 'make this shorter', target())
    expect(r).toEqual({ kind: 'selection', text: 'copied text', via: 'copy' })
    expect(executed).toEqual([{ type: 'hotkey', keys: ['ctrl', 'c'] }])
    expect(clip.text).toBe('ORIGINAL')
  })

  it('never copies for a weak command, in a terminal or an IDE', async () => {
    for (const [cmd, t] of [
      ['make sure it works', target()],
      ['make this shorter', target({ process: 'windowsterminal.exe' })],
      ['make this shorter', target({ process: 'code.exe' })],
      ['make this shorter', target({ password: true })]
    ] as const) {
      const { io, executed } = fakeIo({ copied: 'x' })
      expect(await readSelection(io, cmd, t)).toEqual({ kind: 'none' })
      expect(executed).toEqual([])
    }
    expect(copyFallbackAllowed(target({ process: 'cursor.exe' }))).toBe(false)
  })

  it('reports none when the copy got nothing', async () => {
    const { io, clip } = fakeIo({ copied: '' })
    expect(await readSelection(io, 'make this shorter', target())).toEqual({ kind: 'none' })
    expect(clip.text).toBe('ORIGINAL')
  })
})

describe('canWriteBack (M1)', () => {
  it('writes back only into an element UI Automation calls editable', () => {
    expect(canWriteBack(target())).toBe(true)
    expect(canWriteBack(target({ editable: false }))).toBe(false)
    expect(canWriteBack(target({ uia: false }))).toBe(false)
    expect(canWriteBack(target({ password: true }))).toBe(false)
  })
})

describe('rewriteSelection', () => {
  it('fences the selection and returns the reply', async () => {
    const complete = vi.fn(async () => ({ text: '```\nShorter.\n```' }))
    const out = await rewriteSelection('A long text.', 'make it shorter', {
      resolve: () => ({ llm: { complete } as never, model: 'm' })
    })
    expect(out).toBe('Shorter.')
    const req = (complete.mock.calls[0] as unknown[])[0] as {
      system: { text: string }[]
      messages: { content: string }[]
    }
    expect(req.system[0].text).toBe(EDIT_PROMPT)
    expect(req.messages[0].content).toContain('<selection>A long text.</selection>')
    expect(req.messages[0].content).toContain('<instruction>make it shorter</instruction>')
  })

  it('throws on an empty reply', async () => {
    const complete = vi.fn(async () => ({ text: '  ' }))
    await expect(
      rewriteSelection('x', 'shorter', {
        resolve: () => ({ llm: { complete } as never, model: 'm' })
      })
    ).rejects.toThrow()
  })
})

describe('writeBack', () => {
  it('types short text over the selection', async () => {
    const { io, executed } = fakeIo()
    expect(writeBackAction('short')).toBe('type')
    expect(await writeBack(io, 'short')).toEqual({ type: 'type', text: 'short' })
    expect(executed).toEqual([{ type: 'type', text: 'short' }])
  })

  it('pastes long or multi-line text and restores the clipboard', async () => {
    const { io, executed, clip } = fakeIo()
    expect(await writeBack(io, '- a\n- b')).toEqual({ type: 'hotkey', keys: ['ctrl', 'v'] })
    expect(executed).toEqual([{ type: 'hotkey', keys: ['ctrl', 'v'] }])
    expect(clip.text).toBe('ORIGINAL')
    expect(writeBackAction('x'.repeat(400))).toBe('paste')
  })
})

describe('editSummary', () => {
  it('clips both sides', () => {
    expect(editSummary('hello   world', 'hi')).toBe('Edited: “hello world” → “hi”')
    expect(editSummary('x'.repeat(100), 'y', 10)).toBe(`Edited: “${'x'.repeat(9)}…” → “y”`)
  })
})
