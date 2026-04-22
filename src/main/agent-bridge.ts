import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { Action } from './index'

export class AgentBridge {
  private proc: ChildProcess | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private idCounter = 0
  private buffer = ''
  private eventHandlers: Record<string, Array<() => void>> = {}

  onEvent(event: string, cb: () => void): void {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = []
    this.eventHandlers[event].push(cb)
  }

  async start(): Promise<void> {
    const agentDir = is.dev
      ? join(app.getAppPath(), 'agent')
      : join(process.resourcesPath, 'agent')

    const venvPython =
      process.platform === 'win32'
        ? join(agentDir, '.venv', 'Scripts', 'python.exe')
        : join(agentDir, '.venv', 'bin', 'python3')

    this.proc = spawn(venvPython, [join(agentDir, 'main.py')], {
      cwd: agentDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: string; event?: string }
          if (msg.event) {
            if (msg.event !== 'mouse-moved') console.log('[bridge] event:', msg.event)
            const handlers = this.eventHandlers[msg.event] ?? []
            handlers.forEach((h) => h())
            continue
          }
          const pending = this.pending.get(msg.id!)
          if (pending) {
            this.pending.delete(msg.id!)
            if (msg.error) {
              console.error('[bridge] cmd error id=%d:', msg.id, msg.error)
              pending.reject(new Error(msg.error))
            } else {
              pending.resolve(msg.result)
            }
          }
        } catch {
          console.log('[bridge] non-JSON from agent:', line)
        }
      }
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      console.error('[agent]', chunk.toString())
    })

    this.proc.on('exit', (code) => {
      console.log('[agent] exited with code', code)
      if (code !== 0) {
        setTimeout(() => this.start(), 1000)
      }
    })

    await this.call('ping', {})
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }

  async screenshot(): Promise<string> {
    return this.call('screenshot', {}) as Promise<string>
  }

  async activeWindow(): Promise<string> {
    return this.call('active_window', {}) as Promise<string>
  }

  async execute(action: Action): Promise<unknown> {
    if (action.type === 'open_url') return
    return this.call('execute', { action })
  }

  async setHotkey(combo: string): Promise<unknown> {
    return this.call('set_hotkey', { combo })
  }

  async enableWakeWord(phrase: string): Promise<unknown> {
    return this.call('wake_enable', { phrase })
  }

  async disableWakeWord(): Promise<unknown> {
    return this.call('wake_disable', {})
  }

  private call(cmd: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error('Agent not running'))
        return
      }
      const id = ++this.idCounter
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ id, cmd, ...params }) + '\n'
      this.proc.stdin.write(msg)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Agent timeout: ${cmd}`))
        }
      }, 15000)
    })
  }
}
