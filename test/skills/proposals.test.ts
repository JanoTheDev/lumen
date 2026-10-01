import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SkillRunRecord } from '@shared/types'
import type { AgentRunTrace } from '../../src/main/skills/authoring'
import { needsUpdate } from '../../src/main/skills/health'
import {
  ProposalStore,
  isCorrection,
  matchOfferAnswer,
  requestWords,
  similarity
} from '../../src/main/skills/proposals'

const run = (prompt: string, names: string[], at = 0): AgentRunTrace => ({
  prompt,
  summary: 'Done.',
  at,
  steps: names.map((n) => ({ tool: 'act', op: 'invoke', element: { name: n } }))
})

const opts = { corrected: false, covered: false, now: 1 }

describe('skill proposals', () => {
  it('says alike runs are alike and others are not', () => {
    const st = new ProposalStore(null)
    const a = st.signature(run('export the image as png', ['File', 'Export As', 'Export']))
    const b = st.signature(run('export this picture as a png', ['File', 'Export As', 'Export']))
    const c = st.signature(run('mail the report to anna', ['New mail', 'Send']))
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.6)
    expect(similarity(a, c)).toBeLessThan(0.3)
  })

  it('keeps no request words or values, only hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-prop-'))
    try {
      const file = join(dir, 'p.json')
      const key = Buffer.alloc(32, 7)
      const s = new ProposalStore(file, { key })
      s.consider(run('mail the secret plan to anna@example.com', ['Send']), opts)
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toMatch(/secret|anna|Send/)
      expect(new ProposalStore(file, { key }).data.runs).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(requestWords('Mail "Q3 plan" to bob@x.com at https://x.com now')).toEqual(['mail'])
  })

  it('hashes with a per-install key, drops plain hashes and keeps nothing in private mode', () => {
    const r = run('export the image as png', ['File', 'Export As'])
    const one = new ProposalStore(null, { key: Buffer.alloc(32, 1) }).signature(r)
    const two = new ProposalStore(null, { key: Buffer.alloc(32, 2) }).signature(r)
    expect(one.words.some((w) => two.words.includes(w))).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), 'lumen-prop-'))
    try {
      const file = join(dir, 'p.json')
      writeFileSync(
        file,
        JSON.stringify({
          runs: [{ sig: { words: ['ab'], actions: [] }, at: 1 }],
          patterns: [],
          off: true,
          noticed: []
        })
      )
      const upgraded = new ProposalStore(file)
      expect(upgraded.data.runs).toEqual([])
      expect(upgraded.data.off).toBe(true)
      rmSync(file)
      let record = false
      const priv = new ProposalStore(file, { canRecord: () => record })
      expect(priv.consider(r, opts)).toBeNull()
      expect(priv.consider(r, opts)).toBeNull()
      expect(existsSync(file)).toBe(false)
      record = true
      expect(priv.consider(r, opts)).toBeNull()
      expect(priv.consider(r, opts)?.reason).toBe('repeated')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('offers on the second alike success, once per pattern', () => {
    const s = new ProposalStore(null)
    const r = run('export the image as png', ['File', 'Export As'])
    expect(s.consider(r, opts)).toBeNull()
    const v = s.consider(r, opts)
    expect(v?.reason).toBe('repeated')
    s.answered(v!.sig, 'offered', 2)
    expect(s.consider(r, opts)).toBeNull()
    // Something else still can be offered later.
    const other = run('mail the report', ['New mail', 'Send'])
    s.consider(other, opts)
    expect(s.consider(other, opts)?.reason).toBe('repeated')
  })

  it('offers a corrected run at once, but never for a skill run, a covered request or when off', () => {
    const s = new ProposalStore(null)
    const r = run('rename the layer', ['Layer', 'Rename'])
    expect(s.consider({ ...r, skill: 'x' }, { ...opts, corrected: true })).toBeNull()
    expect(s.consider(r, { ...opts, corrected: true, covered: true })).toBeNull()
    expect(s.consider(r, { ...opts, corrected: true })?.reason).toBe('corrected')
    s.setOff(true)
    expect(s.consider(run('x y z', ['A']), { ...opts, corrected: true })).toBeNull()
  })

  it('remembers a no', () => {
    const s = new ProposalStore(null)
    const r = run('crop the photo', ['Crop'])
    s.consider(r, opts)
    const v = s.consider(r, opts)!
    s.answered(v.sig, 'no', 3)
    expect(s.consider(r, opts)).toBeNull()
    expect(s.consider(r, { ...opts, corrected: true })).toBeNull()
  })

  it('notices a stale skill once until it changes', () => {
    const s = new ProposalStore(null)
    expect(s.noticeOnce('a')).toBe(true)
    expect(s.noticeOnce('a')).toBe(false)
    s.clearNotice('a')
    expect(s.noticeOnce('a')).toBe(true)
  })

  it('reads corrections and offer answers', () => {
    expect(isCorrection('No, the other one')).toBe(true)
    expect(isCorrection('I said the blue folder')).toBe(true)
    expect(isCorrection('actually use Chrome')).toBe(true)
    expect(isCorrection('what time is it')).toBe(false)
    expect(isCorrection('nothing')).toBe(false)
    expect(matchOfferAnswer('Yes please')).toBe('yes')
    expect(matchOfferAnswer('no thanks')).toBe('no')
    expect(matchOfferAnswer("don't ask again")).toBe('never')
    expect(matchOfferAnswer('stop offering skills')).toBe('never')
    expect(matchOfferAnswer('open mail')).toBeNull()
  })
})

describe('skill health', () => {
  const rec = (
    how: SkillRunRecord['how'],
    status: SkillRunRecord['status'] = 'done'
  ): SkillRunRecord => ({
    at: 0,
    ms: 1,
    how,
    status,
    summary: '',
    actions: 1
  })

  it('needs an update after repeated drift or failure, not after one', () => {
    expect(needsUpdate([rec('steps+agent')])).toBe(false)
    expect(needsUpdate([rec('steps+agent'), rec('steps+agent'), rec('steps')])).toBe(true)
    expect(needsUpdate([rec('agent', 'failed'), rec('steps'), rec('agent', 'failed')])).toBe(true)
    // Fine again after a clean run.
    expect(needsUpdate([rec('steps'), rec('steps+agent'), rec('steps+agent')])).toBe(false)
    // Cancelled runs do not count.
    expect(needsUpdate([rec('steps+agent'), rec('agent', 'cancelled'), rec('steps')])).toBe(false)
  })
})
