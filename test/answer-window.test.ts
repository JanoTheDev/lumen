import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())

const state = { answer: undefined as { markdown: string; pinned: boolean } | undefined }
const assistant = vi.hoisted(() => ({
  state: vi.fn(),
  pinAnswer: vi.fn(),
  showAnswer: vi.fn(),
  send: vi.fn(),
  close: vi.fn()
}))
vi.mock('../src/main/windows/assistant', () => assistant)

import { send, showText } from '../src/main/windows/answer'

beforeEach(() => {
  vi.clearAllMocks()
  state.answer = undefined
  assistant.state.mockImplementation(() => state)
})

describe('answer card', () => {
  it('does not carry the pin over to a different answer', () => {
    state.answer = { markdown: 'old', pinned: true }
    showText('new')
    expect(assistant.pinAnswer).toHaveBeenCalledWith(false)
    expect(assistant.showAnswer).toHaveBeenCalledWith('new')
  })

  it('keeps the pin when the same answer is shown again', () => {
    state.answer = { markdown: 'same', pinned: true }
    send('answer:text', 'same')
    expect(assistant.pinAnswer).not.toHaveBeenCalled()
    expect(assistant.showAnswer).toHaveBeenCalledWith('same')
  })
})
