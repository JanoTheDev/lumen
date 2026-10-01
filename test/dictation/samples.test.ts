// Offline checks on the live eval set (eval/dictation): shape, and that the local fallback
// cleanup keeps every sample's words.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { localCleanup, wordsPreserved } from '../../src/main/speech/dictation/cleanup'

const data = JSON.parse(
  readFileSync(join(__dirname, '../../eval/dictation/samples.json'), 'utf8')
) as { dictionary: string[]; samples: { id: number; raw: string }[] }

describe('dictation eval samples', () => {
  it('has 30 unique samples', () => {
    expect(data.samples).toHaveLength(30)
    expect(new Set(data.samples.map((s) => s.id)).size).toBe(30)
  })

  it.each(data.samples.map((s) => [s.id, s.raw] as const))(
    'local cleanup keeps the words of #%i',
    (_id, raw) => {
      expect(wordsPreserved(raw, localCleanup(raw))).toBe(true)
    }
  )
})
