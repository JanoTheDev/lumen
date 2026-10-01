import { describe, expect, it } from 'vitest'
import { fetchPack, githubPackSource } from '../../src/main/packs/fetch'

describe('githubPackSource', () => {
  it('maps GitHub links to direct downloads', () => {
    expect(githubPackSource('https://github.com/me/packs').url).toBe(
      'https://codeload.github.com/me/packs/zip/HEAD'
    )
    expect(githubPackSource('https://github.com/me/packs.git/').url).toBe(
      'https://codeload.github.com/me/packs/zip/HEAD'
    )
    expect(githubPackSource('https://github.com/me/packs/blob/main/out/blender.lumen').url).toBe(
      'https://raw.githubusercontent.com/me/packs/main/out/blender.lumen'
    )
    const rel = 'https://github.com/me/packs/releases/download/v1/blender.lumen'
    expect(githubPackSource(rel).url).toBe(rel)
    expect(githubPackSource('https://github.com/me/packs/tree/main/apps/blender')).toEqual({
      url: 'https://codeload.github.com/me/packs/zip/main',
      subpath: 'apps/blender',
      label: 'github.com/me/packs/tree/main/apps/blender'
    })
    const raw = 'https://raw.githubusercontent.com/me/packs/main/blender.lumen'
    expect(githubPackSource(raw).url).toBe(raw)
  })

  it('refuses everything else', () => {
    expect(() => githubPackSource('http://github.com/me/packs')).toThrow(/https/)
    expect(() => githubPackSource('https://example.com/p.lumen')).toThrow(/only GitHub/)
    expect(() => githubPackSource('https://github.com/me')).toThrow(/owner and repository/)
    expect(() => githubPackSource('https://github.com/me/packs/blob/main/x.exe')).toThrow(/\.lumen/)
    expect(() => githubPackSource('https://github.com/me/packs/issues/1')).toThrow()
    expect(() => githubPackSource('not a url')).toThrow(/web address/)
  })
})

describe('fetchPack', () => {
  it('refuses hosts outside the allowlist before connecting', async () => {
    await expect(fetchPack('https://example.com/p.lumen')).rejects.toThrow(/not allowed/)
    await expect(fetchPack('http://github.com/p.lumen')).rejects.toThrow(/https/)
  })
})
