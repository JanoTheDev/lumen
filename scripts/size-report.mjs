/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Bundle-size budget for the electron-vite output in out/ (run after `electron-vite build`;
// nothing is launched). Prints every chunk as markdown and exits 1 when a budget is exceeded:
//   largest renderer JS chunk <= 400 KB gzip, main bundle (out/main, all .js) <= 3 MB raw
//   (dependencies stay external; main is our own unminified code, kept readable for stack traces).
//   npm run size:report [-- <out dir>]
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { pathToFileURL } from 'url'
import { gzipSync } from 'zlib'

const KB = 1024
export const BUDGET = { rendererChunkGzip: 400 * KB, mainTotal: 3 * KB * KB }

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** Sizes of every .js/.css file under out/{main,preload,renderer}. */
export function measure(outDir) {
  const files = []
  for (const part of ['main', 'preload', 'renderer']) {
    const dir = join(outDir, part)
    if (!existsSync(dir)) continue
    for (const p of walk(dir)) {
      if (!/\.(m?js|css)$/.test(p)) continue
      const buf = readFileSync(p)
      files.push({
        part,
        file: relative(outDir, p).replace(/\\/g, '/'),
        bytes: buf.length,
        gzip: gzipSync(buf, { level: 9 }).length
      })
    }
  }
  return files.sort((a, b) => b.gzip - a.gzip)
}

/** Budget failures for measured files (empty = within budget). */
export function check(files, budget = BUDGET) {
  const failures = []
  const rendererJs = files.filter((f) => f.part === 'renderer' && /\.m?js$/.test(f.file))
  const largest = rendererJs[0]
  if (largest && largest.gzip > budget.rendererChunkGzip)
    failures.push(
      `renderer chunk ${largest.file} is ${kb(largest.gzip)} gzip (budget ${kb(budget.rendererChunkGzip)})`
    )
  const main = files.filter((f) => f.part === 'main' && /\.m?js$/.test(f.file))
  const mainTotal = main.reduce((n, f) => n + f.bytes, 0)
  if (mainTotal > budget.mainTotal)
    failures.push(`main bundle is ${kb(mainTotal)} (budget ${kb(budget.mainTotal)})`)
  if (!main.length) failures.push('no main bundle found; run electron-vite build first')
  return failures
}

const kb = (n) => `${(n / KB).toFixed(1)} KB`

export function formatMarkdown(files, failures) {
  const rows = files.map((f) => `| ${f.file} | ${kb(f.bytes)} | ${kb(f.gzip)} |`)
  const total = (part) => files.filter((f) => f.part === part).reduce((n, f) => n + f.bytes, 0)
  return [
    '| file | raw | gzip |',
    '| --- | ---: | ---: |',
    ...rows,
    '',
    `main ${kb(total('main'))} · preload ${kb(total('preload'))} · renderer ${kb(total('renderer'))}`,
    '',
    failures.length ? failures.map((f) => `FAIL ${f}`).join('\n') : 'ok   within budget'
  ].join('\n')
}

function main(argv) {
  const outDir = argv[0] ?? join(process.cwd(), 'out')
  if (!existsSync(outDir)) {
    console.error(`missing ${outDir}; run npx electron-vite build first`)
    process.exit(1)
  }
  const files = measure(outDir)
  const failures = check(files)
  console.log(formatMarkdown(files, failures))
  if (failures.length) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
