import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TaskQueue } from '../src/main/task-queue'

describe('TaskQueue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs a single job and resolves with its value', async () => {
    const q = new TaskQueue(1, 'test')
    const result = await q.enqueue('job1', async () => 42)
    expect(result).toBe(42)
  })

  it('serializes jobs when concurrency is 1', async () => {
    const q = new TaskQueue(1, 'test')
    const order: number[] = []
    const starts: number[] = []
    const finish = (n: number, delay: number) => q.enqueue(`job${n}`, async () => {
      starts.push(n)
      await new Promise(r => setTimeout(r, delay))
      order.push(n)
    })
    await Promise.all([finish(1, 20), finish(2, 5), finish(3, 5)])
    expect(order).toEqual([1, 2, 3])
    expect(starts).toEqual([1, 2, 3])
  })

  it('propagates errors and continues the queue', async () => {
    const q = new TaskQueue(1, 'test')
    const err = new Error('boom')
    const rejected = q.enqueue('bad', async () => { throw err })
    const next = q.enqueue('good', async () => 'ok')
    await expect(rejected).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })

  it('allows parallel execution when concurrency is higher', async () => {
    const q = new TaskQueue(3, 'test')
    const running: number[] = []
    const maxConcurrent = { n: 0 }
    const job = (n: number) => q.enqueue(`j${n}`, async () => {
      running.push(n)
      maxConcurrent.n = Math.max(maxConcurrent.n, running.length)
      await new Promise(r => setTimeout(r, 10))
      running.splice(running.indexOf(n), 1)
      return n
    })
    await Promise.all([job(1), job(2), job(3)])
    expect(maxConcurrent.n).toBe(3)
  })
})
