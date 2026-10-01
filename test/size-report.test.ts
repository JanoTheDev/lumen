import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { tempDir } from './helpers/fixtures'
import { BUDGET, check, formatMarkdown, measure } from '../scripts/size-report.mjs'

let tmp: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

function outDir(files: Record<string, Buffer | string>): string {
  tmp = tempDir()
  for (const [rel, data] of Object.entries(files)) {
    const p = join(tmp.dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, data)
  }
  return tmp.dir
}

describe('size-report', () => {
  it('measures raw and gzip sizes per file, largest gzip first', () => {
    const dir = outDir({
      'main/index.js': 'x'.repeat(10_000),
      'preload/index.js': 'p',
      'renderer/assets/a.js': randomBytes(5000),
      'renderer/assets/a.css': 'body{}',
      'renderer/panel.html': '<html>'
    })
    const files = measure(dir)
    expect(files.map((f) => f.file)).not.toContain('renderer/panel.html')
    expect(files[0].file).toBe('renderer/assets/a.js')
    const main = files.find((f) => f.file === 'main/index.js')!
    expect(main.bytes).toBe(10_000)
    expect(main.gzip).toBeLessThan(200)
    expect(check(files)).toEqual([])
    expect(formatMarkdown(files, [])).toContain('ok   within budget')
  })

  it('fails a renderer chunk over the gzip budget and a main bundle over 3 MB', () => {
    const files = [
      { part: 'renderer', file: 'renderer/assets/big.js', bytes: 2e6, gzip: 500 * 1024 },
      { part: 'renderer', file: 'renderer/assets/big.css', bytes: 2e6, gzip: 900 * 1024 },
      { part: 'main', file: 'main/index.js', bytes: 2.5 * 1024 * 1024, gzip: 1 },
      { part: 'main', file: 'main/worker.js', bytes: 0.6 * 1024 * 1024, gzip: 1 }
    ].sort((a, b) => b.gzip - a.gzip)
    const failures = check(files)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatch(/big\.js is 500\.0 KB gzip/)
    expect(failures[1]).toMatch(/main bundle is 2150\.4 KB/)
    expect(BUDGET.rendererChunkGzip).toBe(400 * 1024)
  })

  it('an empty out dir fails instead of passing silently', () => {
    expect(check(measure(outDir({})))).toEqual([
      'no main bundle found; run electron-vite build first'
    ])
  })
})
