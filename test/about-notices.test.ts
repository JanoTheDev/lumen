import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { NOTICES, licenceUrl } from '../src/renderer/src/panel/settings/sections/AboutNotices'

describe('third-party notices', () => {
  const file = readFileSync('build/third_party/NOTICES.txt', 'utf8')

  it('every About entry links over https and is in the shipped NOTICES.txt', () => {
    for (const n of NOTICES) {
      expect(n.url).toMatch(/^https:\/\//)
      expect(file).toContain(n.name.split(/[ ,]/)[0])
      expect(file).toContain(n.licence.split(' ')[0])
    }
  })

  it('CC-BY models carry their licence link (attribution)', () => {
    const cc = NOTICES.filter((n) => n.licence === 'CC-BY-4.0')
    expect(cc.map((n) => n.name)).toContain('Parakeet TDT-CTC 110M (NVIDIA)')
    for (const n of cc) expect(licenceUrl(n.licence)).toMatch(/creativecommons\.org/)
    expect(file).toContain('https://creativecommons.org/licenses/by/4.0/')
  })
})
