/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Checks a Windows build in dist/: asar contents, no API keys, native files, sidecar
// handshake, size budgets. Writes dist/SHA256SUMS.txt. Usage: node scripts/verify-package.mjs
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const unpacked = join(dist, 'win-unpacked')
const resources = join(unpacked, 'resources')
const appAsar = join(resources, 'app.asar')

const MB = 1024 * 1024
const BUDGET = { installer: 95 * MB, installed: 330 * MB, asar: 15 * MB }
const REQUIRED_CAPS = ['hotkey', 'input', 'capture', 'ocr', 'uia', 'dwell', 'wake', 'execute']

const failures = []
const fail = (msg) => failures.push(msg)
const ok = (msg) => console.log(`ok   ${msg}`)
const mb = (n) => `${(n / MB).toFixed(1)} MB`

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const dirSize = (dir) => walk(dir).reduce((n, f) => n + statSync(f).size, 0)

if (!existsSync(appAsar)) {
  console.error(`missing ${appAsar}; run npm run build:win first`)
  process.exit(1)
}

// 1. asar holds the app bundle only.
const FORBIDDEN = [
  [/^\/(agent|native|plans|test|eval|src|docs|scripts|build)\//, 'source/dev folder'],
  [/(^|\/)\.venv\//, 'python venv'],
  [/(^|\/)\.env(\.|$)/, '.env file'],
  [/\.map$/, 'source map']
]
// listPackage gives OS separators; extractFile wants the same spelling without the leading one.
const rawEntries = asar.listPackage(appAsar)
const entries = rawEntries.map((p) => p.replace(/\\/g, '/'))
for (const [re, what] of FORBIDDEN) {
  const hits = entries.filter((e) => re.test(e))
  if (hits.length) fail(`app.asar contains ${what}: ${hits.slice(0, 3).join(', ')}`)
}
for (const need of ['/out/main/index.js', '/package.json', '/skills']) {
  if (!entries.includes(need)) fail(`app.asar is missing ${need}`)
}
ok(`app.asar: ${entries.length} entries checked`)

// 2. No API keys anywhere in the bundle (literal .env values and key-shaped strings).
const KEY_SHAPES = [/sk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/]
const envValues = []
const envFile = join(root, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*[A-Z0-9_]*KEY\s*=\s*"?([^"\s#]{16,})/.exec(line)
    if (m) envValues.push(m[1])
  }
}
let scanned = 0
for (const [i, entry] of entries.entries()) {
  if (!/\.(js|cjs|mjs|json|html|txt|env)$/.test(entry)) continue
  let text
  try {
    text = asar.extractFile(appAsar, rawEntries[i].slice(1)).toString('utf8')
  } catch {
    continue // directory or unpacked file
  }
  scanned++
  if (envValues.some((v) => text.includes(v))) fail(`${entry} contains a key from .env`)
  for (const re of KEY_SHAPES) if (re.test(text)) fail(`${entry} contains a key-shaped string`)
}
ok(`no API keys in ${scanned} bundled text files (${envValues.length} .env keys checked)`)

// 3. Native files where main and the sidecar look for them.
const nativeExe = join(resources, 'native', 'lumen-native.exe')
const needed = [
  nativeExe,
  join(resources, 'native', 'nvdaControllerClient.dll'),
  join(resources, 'third_party', 'NOTICES.txt'),
  join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'),
  join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'onnxruntime.dll'),
  join(unpacked, 'Lumen.exe')
]
for (const f of needed) if (!existsSync(f)) fail(`missing ${relative(dist, f)}`)
for (const f of [join(resources, 'agent'), join(resources, 'app.asar.unpacked', '.env')]) {
  if (existsSync(f)) fail(`should not ship ${relative(dist, f)}`)
}
ok('native sidecar, NVDA client, sherpa-onnx addon and notices present')

// 4. The sidecar starts and advertises what auto mode needs.
async function handshake() {
  if (!existsSync(nativeExe)) return
  const child = spawn(nativeExe, ['--protocol', '2'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const line = await new Promise((resolve) => {
    let buf = ''
    const timer = setTimeout(() => resolve(null), 10_000)
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        clearTimeout(timer)
        resolve(buf.slice(0, nl))
      }
    })
    child.on('error', () => resolve(null))
  })
  child.kill()
  if (!line) return fail('lumen-native.exe did not send ready within 10 s')
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return fail(`lumen-native.exe first line is not JSON: ${line.slice(0, 80)}`)
  }
  const caps = msg?.data?.capabilities ?? []
  if (msg.event !== 'ready') return fail(`lumen-native.exe first event is ${msg.event}`)
  const missing = REQUIRED_CAPS.filter((c) => !caps.includes(c))
  if (missing.length) fail(`lumen-native.exe lacks ${missing.join(', ')}`)
  else ok(`lumen-native ${msg.data.version} ready (${caps.length} capabilities)`)
}
await handshake()

// 5. Size budgets (native-only column in the release spec).
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installer = join(dist, `Lumen-Setup-${pkg.version}.exe`)
const portable = join(dist, `Lumen-${pkg.version}-portable.exe`)
const sizes = {
  asar: statSync(appAsar).size,
  installed: dirSize(unpacked),
  installer: existsSync(installer) ? statSync(installer).size : 0
}
for (const [k, v] of Object.entries(sizes)) {
  if (!v) continue
  if (v > BUDGET[k]) fail(`${k} ${mb(v)} is over the ${mb(BUDGET[k])} budget`)
  else ok(`${k} ${mb(v)} (budget ${mb(BUDGET[k])})`)
}

// 6. SHA256SUMS.txt for the release artifacts.
const artifacts = [installer, `${installer}.blockmap`, portable, join(dist, 'latest.yml')].filter(
  existsSync
)
if (artifacts.length) {
  const sums = artifacts
    .map(
      (f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${relative(dist, f)}`
    )
    .join('\n')
  writeFileSync(join(dist, 'SHA256SUMS.txt'), sums + '\n')
  ok(`SHA256SUMS.txt (${artifacts.length} files)`)
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
console.log('package verified')
