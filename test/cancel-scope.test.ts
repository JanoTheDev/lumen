import { describe, it, expect } from 'vitest'
import { beginScope, endScope, cancelAll, isAbortError, CancelledError } from '../src/main/query/cancel'

describe('CancelScope', () => {
  it('cancelAll aborts every active scope and its children', () => {
    const a = beginScope()
    const b = beginScope()
    const child = a.child()
    expect(cancelAll()).toBe(true)
    expect(a.signal.aborted && b.signal.aborted && child.cancelled).toBe(true)
    expect(() => a.throwIfCancelled()).toThrow(CancelledError)
    endScope(a)
    endScope(b)
    expect(cancelAll()).toBe(false)
  })

  it('children of a cancelled scope start cancelled', () => {
    const s = beginScope()
    s.cancel()
    expect(s.child().cancelled).toBe(true)
    endScope(s)
  })

  it('recognizes SDK abort errors', () => {
    const sdkAbort = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
    expect(isAbortError(sdkAbort)).toBe(true)
    expect(isAbortError(new CancelledError())).toBe(true)
    expect(isAbortError(new Error('boom'))).toBe(false)
  })
})
