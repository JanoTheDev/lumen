import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

const attachmentsFor = vi.fn()
vi.mock('../../src/main/files/attach', async (orig) => ({
  ...(await orig<typeof import('../../src/main/files/attach')>()),
  attachmentsFor: (...args: unknown[]) => attachmentsFor(...args)
}))

import { filesForCall, newFileClaim } from '../../src/main/ai'

const files = { text: 'file text', images: [], documents: [] }
const aboutFiles = (prompt: string): Promise<typeof files | null> =>
  Promise.resolve(/pdf/.test(prompt) ? files : null)

describe('dropped files in a split question', () => {
  it('go with the first part about them only', async () => {
    attachmentsFor.mockImplementation(aboutFiles)
    const claim = newFileClaim()
    const got = await Promise.all(
      ['what time is it', 'summarize the pdf', 'translate the pdf'].map((q) =>
        filesForCall(q, { pdf: true }, claim)
      )
    )
    expect(got).toEqual([null, files, null])
  })

  it('without a claim every call looks for its files', async () => {
    attachmentsFor.mockImplementation(aboutFiles)
    const got = await Promise.all(
      ['summarize the pdf', 'translate the pdf'].map((q) =>
        filesForCall(q, { pdf: true }, undefined)
      )
    )
    expect(got).toEqual([files, files])
  })
})
