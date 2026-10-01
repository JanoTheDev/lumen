// Where the native agent (`lumen-native`, the Rust sidecar) lives and how it is launched.
import { join } from 'path'

export interface LaunchSpec {
  command: string
  args: string[]
  cwd: string
}

export interface AgentPathEnv {
  dev: boolean
  appPath: string
  resourcesPath: string
  platform: NodeJS.Platform
  exists: (path: string) => boolean
}

/** Capabilities main relies on; a ready agent missing any of them is logged. */
export const REQUIRED_NATIVE_CAPABILITIES = [
  'hotkey',
  'dictation-hotkey',
  'input',
  'capture',
  'ocr',
  'uia',
  'dwell',
  'announce',
  'execute'
] as const

/** Native exe paths to try, in order. Dev also accepts the faster local `fastrel` build. */
export function nativeCandidates(env: AgentPathEnv): string[] {
  if (!env.dev) return [join(env.resourcesPath, 'native', 'lumen-native.exe')]
  const target = join(env.appPath, 'native', 'target')
  return [join(target, 'release', 'lumen-native.exe'), join(target, 'fastrel', 'lumen-native.exe')]
}

/** The launch for the first candidate that exists, or null (none built, or not Windows). */
export function nativeLaunch(env: AgentPathEnv): LaunchSpec | null {
  if (env.platform !== 'win32') return null
  const command = nativeCandidates(env).find((p) => env.exists(p))
  if (!command) return null
  return { command, args: ['--protocol', '2'], cwd: join(command, '..') }
}

export function missingCapabilities(capabilities: readonly string[]): string[] {
  return REQUIRED_NATIVE_CAPABILITIES.filter((c) => !capabilities.includes(c))
}
