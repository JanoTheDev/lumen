// Claude Code session history in the task chat (08 T43): read-only, the file's newest part,
// redacted, only into an empty chat.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  findSessionFile,
  loadClaudeHistory,
  projectDirName,
  readTail
} from '../../src/main/agent-mode/transcript-history'
import { TranscriptRecorder } from '../../src/main/agent-mode/transcript'
import { TranscriptHub } from '../../src/main/agent-mode/transcript-hub'
import { tempDir } from '../helpers/fixtures'

let tmp: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

const SID = '1a2b3c4d-0000-4000-8000-123456789abc'
const pw = ['hunter2', 'hunter2'].join('')

const lines = [
  { type: 'mode', mode: 'normal', sessionId: SID },
  { type: 'user', message: { role: 'user', content: 'fix the failing test' } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' } },
  {
    type: 'user',
    message: { role: 'user', content: '<command-name>/clear</command-name>' }
  },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Reading the config.' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:\\app\\.env' } }
      ]
    }
  },
  {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `DB_PASSWORD=${pw}` }]
    }
  },
  {
    type: 'assistant',
    isSidechain: true,
    message: { content: [{ type: 'text', text: 'helper chatter' }] }
  },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it.' }] } }
]
const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

function recorder(): TranscriptRecorder {
  let t = 0
  return new TranscriptRecorder('cc_hist01', { now: () => ++t })
}

describe('Claude session history', () => {
  it('finds the session file in its project folder, else in any', () => {
    tmp = tempDir()
    const project = 'C:\\code\\my app'
    const dir = join(tmp.dir, projectDirName(project))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SID}.jsonl`), jsonl)
    expect(projectDirName(project)).toBe('C--code-my-app')
    expect(findSessionFile(SID, project, tmp.dir)).toBe(join(dir, `${SID}.jsonl`))
    expect(findSessionFile(SID, 'D:\\moved\\elsewhere', tmp.dir)).toBe(join(dir, `${SID}.jsonl`))
    expect(findSessionFile('../../etc/passwd', project, tmp.dir)).toBeNull()
  })

  it('keeps the user’s words, Claude’s text and tools; skips meta, commands and helpers', () => {
    const rec = recorder()
    expect(loadClaudeHistory(rec, jsonl)).toBeGreaterThan(0)
    const kinds = rec.entries.map((e) => e.k)
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'assistant', 'status'])
    const json = JSON.stringify(rec.data())
    expect(json).not.toContain(pw)
    expect(json).not.toContain('helper chatter')
    expect(json).not.toContain('/clear')
  })

  it('reads only the end of a long file, from a whole line', () => {
    tmp = tempDir()
    const file = join(tmp.dir, 'big.jsonl')
    writeFileSync(file, 'x'.repeat(5000) + '\n' + jsonl)
    const tail = readTail(file, jsonl.length + 10)
    expect(tail.startsWith('{')).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(jsonl.length + 10)
  })

  it('fills only an empty chat, once', () => {
    const hub = new TranscriptHub({
      now: () => 1,
      setTimer: () => 0,
      clearTimer: () => {}
    })
    hub.setHeaderSource((id) => ({
      id,
      kind: 'claude',
      title: 'Claude: app',
      phase: 'done',
      steps: 0,
      modelCalls: 0,
      costUsd: 0,
      startedAt: 0,
      canStop: false,
      canPause: false,
      canResume: false,
      canRunAgain: false,
      canSteer: true
    }))
    let calls = 0
    hub.setHistorySource((_id, rec) => {
      calls++
      loadClaudeHistory(rec, jsonl)
    })
    expect(hub.view('cc_hist02')?.entries.length).toBe(5)
    hub.view('cc_hist02')
    hub.rec('cc_hist03').user('a new turn')
    expect(hub.view('cc_hist03')?.entries.length).toBe(1)
    expect(calls).toBe(1)
  })
})
