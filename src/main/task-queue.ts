import { log } from './logger'

type Job = () => Promise<void>

export class TaskQueue {
  private queue: Job[] = []
  private running = 0
  private nextId = 1

  constructor(private readonly concurrency: number = 1, private readonly name: string = 'queue') {}

  async enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const id = this.nextId++
    const queuedAt = Date.now()
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        const t0 = Date.now()
        const waitMs = t0 - queuedAt
        log('plan', `${this.name} #${id} start: ${label}${waitMs > 20 ? ` (waited ${(waitMs / 1000).toFixed(2)}s)` : ''}`)
        try {
          const v = await fn()
          log('done', `${this.name} #${id} done`, { timeMs: Date.now() - t0 })
          resolve(v)
        } catch (e) {
          log('fail', `${this.name} #${id} error: ${(e as Error).message}`)
          reject(e)
        }
      })
      if (this.queue.length > 1 || this.running >= this.concurrency) {
        log('plan', `${this.name} #${id} queued (${this.queue.length} waiting, ${this.running} active): ${label}`)
      }
      this.tick()
    })
  }

  private tick(): void {
    if (this.running >= this.concurrency) return
    const next = this.queue.shift()
    if (!next) return
    this.running++
    void next().finally(() => {
      this.running--
      this.tick()
    })
  }

  get pending(): number { return this.queue.length }
  get active(): number { return this.running }
}
