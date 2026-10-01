// Which agent binary to run: the Rust sidecar (native) or the Python agent.
import { join } from 'path'

export type AgentImplPref = 'auto' | 'python' | 'native'
export type AgentImplName = 'python' | 'native'

export interface LaunchSpec {
  impl: AgentImplName
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

export interface AgentPathEnv {
  dev: boolean
  appPath: string
  resourcesPath: string
  platform: NodeJS.Platform
  exists: (path: string) => boolean
}

/**
 * Capabilities main needs before `auto` runs the native agent. `execute` (the
 * v1 action command main still uses) is not ported yet, so `auto` keeps Python
 * until the native agent advertises it.
 */
export const REQUIRED_NATIVE_CAPABILITIES = [
  'hotkey',
  'dictation-hotkey',
  'input',
  'capture',
  'ocr',
  'uia',
  'dwell',
  'wake',
  'announce',
  'execute'
] as const

export const NATIVE_CRASH_LIMIT = 3
export const NATIVE_CRASH_WINDOW_MS = 60000

/** Native exe paths to try, in order. Dev also accepts the faster local `fastrel` build. */
export function nativeCandidates(env: AgentPathEnv): string[] {
  if (!env.dev) return [join(env.resourcesPath, 'native', 'lumen-native.exe')]
  const target = join(env.appPath, 'native', 'target')
  return [join(target, 'release', 'lumen-native.exe'), join(target, 'fastrel', 'lumen-native.exe')]
}

export function nativeLaunch(env: AgentPathEnv): LaunchSpec | null {
  if (env.platform !== 'win32') return null
  const command = nativeCandidates(env).find((p) => env.exists(p))
  if (!command) return null
  return { impl: 'native', command, args: ['--protocol', '2'], cwd: join(command, '..') }
}

/** Packaged: the frozen `lumen-agent.exe` when shipped, else the bundled venv. Dev: the venv. */
export function pythonLaunch(env: AgentPathEnv): LaunchSpec {
  const agentDir = env.dev ? join(env.appPath, 'agent') : join(env.resourcesPath, 'agent')
  const pyEnv = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  const frozen = join(agentDir, 'lumen-agent.exe')
  if (!env.dev && env.exists(frozen)) {
    return { impl: 'python', command: frozen, args: [], cwd: agentDir, env: pyEnv }
  }
  const python =
    env.platform === 'win32'
      ? join(agentDir, '.venv', 'Scripts', 'python.exe')
      : join(agentDir, '.venv', 'bin', 'python3')
  return {
    impl: 'python',
    command: python,
    args: [join(agentDir, 'main.py')],
    cwd: agentDir,
    env: pyEnv
  }
}

export function missingCapabilities(capabilities: readonly string[]): string[] {
  return REQUIRED_NATIVE_CAPABILITIES.filter((c) => !capabilities.includes(c))
}

/**
 * Picks the binary for each (re)start. Once native is given up on (missing
 * exe, failed start, missing capabilities, or NATIVE_CRASH_LIMIT crashes in
 * NATIVE_CRASH_WINDOW_MS) the rest of the session runs Python.
 */
export class ImplSelector {
  private fallbackReason: string | null = null
  private crashes: number[] = []

  constructor(
    private pref: () => AgentImplPref,
    private env: () => AgentPathEnv,
    private now: () => number = Date.now
  ) {}

  /** Why native was dropped for this session, or null. */
  get fallenBack(): string | null {
    return this.fallbackReason
  }

  choose(): LaunchSpec {
    const env = this.env()
    if (this.pref() === 'python' || this.fallbackReason) return pythonLaunch(env)
    const native = nativeLaunch(env)
    if (native) return native
    if (this.pref() === 'native') {
      console.error('[agent] native agent not found (%s); using python', nativeCandidates(env)[0])
    }
    return pythonLaunch(env)
  }

  /** After the ready handshake: a reason to drop native, or null to keep it. */
  check(spec: LaunchSpec, capabilities: readonly string[]): string | null {
    if (spec.impl !== 'native' || this.pref() !== 'auto') return null
    const missing = missingCapabilities(capabilities)
    return missing.length ? `native agent lacks ${missing.join(', ')}` : null
  }

  /** Records a native crash; true once the session should switch to Python. */
  crashed(spec: LaunchSpec): boolean {
    if (spec.impl !== 'native') return false
    const t = this.now()
    this.crashes = this.crashes.filter((c) => t - c < NATIVE_CRASH_WINDOW_MS)
    this.crashes.push(t)
    if (this.crashes.length < NATIVE_CRASH_LIMIT) return false
    this.fallBack(`native agent crashed ${this.crashes.length} times within 60 s`)
    return true
  }

  fallBack(reason: string): void {
    if (this.fallbackReason) return
    this.fallbackReason = reason
    console.error('[agent] %s; using python for this session', reason)
  }
}
