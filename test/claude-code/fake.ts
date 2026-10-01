// Spawns test/claude-code/fake-claude.mjs with node in place of the real `claude` CLI.
import { spawn } from 'child_process'
import { join } from 'path'
import type { SessionDeps } from '../../src/main/claude-code/session'

export const FAKE = join(__dirname, 'fake-claude.mjs')

/** The args Lumen built are passed through to the fake. */
export function fakeSpawn(): SessionDeps['spawn'] {
  return (cmd, cwd, env) =>
    spawn(process.execPath, [FAKE, ...cmd.args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
}
