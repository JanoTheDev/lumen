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
  private eventHandlers: Record<string, Array<(data?: Record<string, unknown>) => void>> = {}

  onEvent(event: string, cb: (data?: Record<string, unknown>) => void): void {
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
            if (msg.event !== 'mouse-moved' && msg.event !== 'dwell-progress') console.log('[bridge] event:', msg.event)
            const handlers = this.eventHandlers[msg.event] ?? []
            const data = msg as unknown as Record<string, unknown>
            handlers.forEach((h) => h(data))
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

  async enableListener(phrase: string, cancelPhrases: string[]): Promise<unknown> {
    return this.call('wake_enable', { phrase, cancel_phrases: cancelPhrases })
  }

  async disableListener(): Promise<unknown> {
    return this.call('wake_disable', {})
  }

  async enableDwell(dwellMs: number, cooldownMs: number): Promise<unknown> {
    return this.call('dwell_enable', { dwell_ms: dwellMs, cooldown_ms: cooldownMs })
  }

  async disableDwell(): Promise<unknown> {
    return this.call('dwell_disable', {})
  }

  async setDwellMs(dwellMs: number): Promise<unknown> {
    return this.call('dwell_set_ms', { dwell_ms: dwellMs })
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
