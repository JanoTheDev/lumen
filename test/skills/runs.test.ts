import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillRunRecord } from '@shared/types'
import { RUNS_PER_SKILL, SkillRunLog } from '../../src/main/skills/runs'
import { runLine } from '../../src/renderer/src/panel/settings/sections/SkillsText'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'lumen-runs-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (at: number, over: Partial<SkillRunRecord> = {}): SkillRunRecord => ({
  at,
  ms: 2500,
  how: 'steps',
  status: 'done',
  summary: 'ok',
  actions: 3,
  ...over
})

describe('skill run history', () => {
  it('keeps the newest runs per skill and survives a restart', () => {
    const file = join(dir, 'skills-runs.json')
    const log = new SkillRunLog(file)
    for (let i = 0; i < RUNS_PER_SKILL + 5; i++) log.add('export-png', run(i))
    log.add('other', run(99, { status: 'denied' }))
    log.add('Bad Name', run(1))
    const again = new SkillRunLog(file)
    const list = again.list('export-png')
    expect(list).toHaveLength(RUNS_PER_SKILL)
    expect(list[0].at).toBe(RUNS_PER_SKILL + 4)
    expect(again.list('other')[0].status).toBe('denied')
    expect(again.list('Bad Name')).toEqual([])
    again.forget('other')
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('other')
  })

  it('drops broken entries and broken files', () => {
    const file = join(dir, 'skills-runs.json')
    writeFileSync(file, JSON.stringify({ a: [run(1), { at: 'x' }], b: 'nope' }))
    expect(new SkillRunLog(file).list('a')).toHaveLength(1)
    writeFileSync(file, '{')
    expect(new SkillRunLog(file).list('a')).toEqual([])
  })

  it('reads as one line in Settings', () => {
    const now = 10 * 60_000
    expect(runLine(run(now - 2 * 60_000), now)).toBe(
      'Done · 2 min ago · recorded steps, no AI · 3 actions · 3 s'
    )
    expect(runLine(run(now, { how: 'steps+agent', status: 'denied', actions: 1 }), now)).toBe(
      'Blocked · just now · recorded steps, then the AI · 1 action · 3 s'
    )
  })
})
