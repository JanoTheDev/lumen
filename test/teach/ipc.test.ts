// Lesson picker IPC (src/main/ipc/teach.ts): payload validation.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
const teach = vi.hoisted(() => ({
  listLessons: vi.fn(() => []),
  saveGeneratedLesson: vi.fn(() => null),
  startOrResume: vi.fn(() => true),
  lessonCommand: vi.fn(() => true),
  lessonProgress: vi.fn(),
  deleteLesson: vi.fn(() => true),
  practiceClick: vi.fn()
}))
vi.mock('../../src/main/teach', () => teach)

import { invokeHandler } from '../helpers/electron-mock'
import { registerTeachIpc } from '../../src/main/ipc/teach'

registerTeachIpc()
const INVALID = { error: 'E_INVALID' }

describe('teach IPC', () => {
  it('teach:list takes no app or a valid app id, and rejects anything else', async () => {
    await invokeHandler('teach:list')
    await invokeHandler('teach:list', 'blender')
    expect(teach.listLessons.mock.calls).toEqual([[undefined], ['blender']])
    expect(await invokeHandler('teach:list', 'Not An Id')).toEqual(INVALID)
    expect(await invokeHandler('teach:list', 42)).toEqual(INVALID)
    expect(teach.listLessons).toHaveBeenCalledTimes(2)
  })

  it('teach:save-last takes no name or a string, and rejects anything else', async () => {
    await invokeHandler('teach:save-last')
    await invokeHandler('teach:save-last', 'my lesson')
    expect(teach.saveGeneratedLesson.mock.calls).toEqual([[undefined], ['my lesson']])
    expect(await invokeHandler('teach:save-last', { name: 'x' })).toEqual(INVALID)
    expect(await invokeHandler('teach:save-last', 'x'.repeat(200))).toEqual(INVALID)
    expect(teach.saveGeneratedLesson).toHaveBeenCalledTimes(2)
  })
})
