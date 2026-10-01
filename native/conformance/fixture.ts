// Starts the WinForms fixture window ("LumenFixture") and returns its HWND.
import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'

export interface Fixture {
  hwnd: number
  proc: ChildProcess
  close(): void
}

export function startFixture(timeoutMs = 20_000): Promise<Fixture> {
  const proc = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(__dirname, 'fixtures', 'Fixture.ps1')
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return new Promise((res, rej) => {
    let out = ''
    const timer = setTimeout(() => {
      proc.kill()
      rej(new Error('fixture did not start'))
    }, timeoutMs)
    proc.stdout!.on('data', (c: Buffer) => {
      out += c.toString()
      const m = out.match(/^(\d+)\s*$/m)
      if (m) {
        clearTimeout(timer)
        res({ hwnd: Number(m[1]), proc, close: () => proc.kill() })
      }
    })
    proc.on('exit', () => rej(new Error('fixture exited')))
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
