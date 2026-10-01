// Ending a Claude Code process with everything it started (shells, MCP servers, a node CLI under
// a cmd.exe shim): Windows does not kill child processes with their parent, so the whole tree
// is ended with System32 taskkill /T /F by pid.
import { execFile, execFileSync } from 'child_process'
import { join } from 'path'

export function taskkillPath(env = process.env): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

export function taskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F']
}

export interface KillRunner {
  sync(file: string, args: string[]): void
  async(file: string, args: string[], done: () => void): void
}

const realRunner: KillRunner = {
  sync: (file, args) => {
    execFileSync(file, args, { windowsHide: true, timeout: 3000, stdio: 'ignore' })
  },
  async: (file, args, done) => {
    execFile(file, args, { windowsHide: true, timeout: 5000 }, () => done())
  }
}

interface Killable {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

/**
 * Ends `child` and its descendants. `sync` blocks until taskkill returns (app quit, when no
 * later tick runs). Falls back to child.kill() off Windows, without a pid, or after taskkill.
 */
export function killTree(
  child: Killable,
  sync: boolean,
  runner: KillRunner = realRunner,
  platform: NodeJS.Platform = process.platform
): void {
  const plain = (): void => {
    try {
      child.kill()
    } catch {
      /* gone */
    }
  }
  const pid = child.pid
  if (platform !== 'win32' || !pid || !Number.isInteger(pid) || pid <= 0) return plain()
  const file = taskkillPath()
  if (sync) {
    try {
      runner.sync(file, taskkillArgs(pid))
    } catch {
      /* already gone, or taskkill missing */
    }
    return plain()
  }
  runner.async(file, taskkillArgs(pid), plain)
}

/** Gives a spawned child a `killTree` (used by ClaudeSession instead of child.kill()). */
export function withTreeKill<T extends Killable>(child: T): T & { killTree(sync: boolean): void } {
  return Object.assign(child, { killTree: (sync: boolean) => killTree(child, sync) })
}
