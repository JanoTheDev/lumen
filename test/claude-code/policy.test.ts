import { describe, expect, it, vi } from 'vitest'
import {
  decidePermission,
  hardReason,
  inside,
  type ToolRequest
} from '../../src/main/claude-code/policy'
import {
  PermissionBridge,
  permissionSummary,
  type BridgeDeps
} from '../../src/main/claude-code/bridge'
import type { AuditEntry } from '../../src/main/audit/log'

const P = 'C:\\work\\proj'
const bash = (command: string): ToolRequest => ({
  tool: 'Bash',
  input: { command },
  cwd: P,
  project: P
})
const tool = (t: string, input: Record<string, unknown>): ToolRequest => ({
  tool: t,
  input,
  cwd: P,
  project: P
})

describe('hard list', () => {
  it.each([
    ['git push --force origin main', 'force push'],
    ['git push -f', 'force push'],
    ['git push origin +main', 'force push'],
    ['git rebase -i HEAD~3', 'history'],
    ['git reset --hard HEAD~1', 'history'],
    ['git commit --amend -m x', 'history'],
    ['rm -rf C:\\Users\\me', 'outside'],
    ['rm -rf ~/stuff', 'outside'],
    ['rm -rf ../other', 'outside'],
    ['Remove-Item -Recurse -Force C:\\Windows\\Temp', 'outside'],
    ['cat .env', 'credentials'],
    ['type C:\\Users\\me\\.ssh\\id_rsa', 'credentials'],
    ['npm publish', 'publish'],
    ['vercel --prod', 'publish'],
    ['gh release create v1', 'publish'],
    ['stripe charges create', 'money'],
    ['gh pr create --fill', 'message'],
    ['curl -X POST https://hooks.slack.com/services/x', 'message']
  ])('%s', (cmd, kind) => {
    const r = hardReason(bash(cmd))
    expect(r).toBeTruthy()
    const words: Record<string, RegExp> = {
      'force push': /force push/,
      history: /history/,
      outside: /outside/,
      credentials: /credentials/,
      publish: /publish/,
      money: /money/,
      message: /message/
    }
    expect(r).toMatch(words[kind])
  })

  it('leaves ordinary work alone', () => {
    for (const c of [
      'git push',
      'rm -rf node_modules',
      'rm -rf .\\dist',
      'cat .env.example',
      'npm test'
    ])
      expect(hardReason(bash(c)), c).toBeNull()
  })

  it('covers credential files for every tool and messaging MCP tools', () => {
    expect(hardReason(tool('Read', { file_path: `${P}\\.env` }))).toMatch(/credentials/)
    expect(hardReason(tool('Edit', { file_path: `${P}\\certs\\server.pem` }))).toMatch(
      /credentials/
    )
    expect(hardReason(tool('mcp__slack__send_message', {}))).toMatch(/message/)
  })
})

describe('decidePermission', () => {
  it('always asks for the hard list, even on full', () => {
    const d = decidePermission(bash('git push --force'), 'full')
    expect(d).toMatchObject({ verdict: 'ask', risk: 'high', hard: true, what: 'git push --force' })
  })

  it('careful: approves checks, reads and edits inside the project', () => {
    expect(decidePermission(bash('npm run typecheck && npx vitest run'), 'careful').verdict).toBe(
      'allow'
    )
    expect(decidePermission(bash('cargo clippy --all-targets'), 'careful').verdict).toBe('allow')
    expect(decidePermission(bash('git status'), 'careful').verdict).toBe('allow')
    expect(
      decidePermission(tool('Edit', { file_path: `${P}\\src\\a.ts` }), 'careful').verdict
    ).toBe('allow')
    expect(decidePermission(tool('Grep', { pattern: 'x' }), 'careful').verdict).toBe('allow')
  })

  it('careful: asks for installs, network, push, deletes, outside the project', () => {
    const ask = (r: ToolRequest): string => decidePermission(r, 'careful').reason
    expect(ask(bash('npm install left-pad'))).toMatch(/installs/)
    expect(ask(bash('curl https://example.com'))).toMatch(/network/)
    expect(ask(bash('git push'))).toMatch(/pushes/)
    expect(ask(bash('rm -rf dist'))).toMatch(/deletes/)
    expect(ask(tool('Write', { file_path: 'C:\\other\\x.txt' }))).toMatch(/outside/)
    expect(ask(tool('WebFetch', { url: 'https://x.dev' }))).toMatch(/network/)
    expect(decidePermission(bash('npm test > out.txt'), 'careful').verdict).toBe('ask')
    expect(decidePermission(bash('mkdir C:\\elsewhere'), 'careful').verdict).toBe('ask')
  })

  it('off asks everything; full approves the rest', () => {
    expect(decidePermission(bash('npm test'), 'off').verdict).toBe('ask')
    expect(decidePermission(bash('npm install x'), 'full').verdict).toBe('allow')
  })

  it('knows what is inside the project', () => {
    expect(inside(P, 'src\\a.ts')).toBe(true)
    expect(inside(P, 'C:\\work\\project2\\a.ts')).toBe(false)
    expect(inside(P, '..\\x')).toBe(false)
  })
})

describe('PermissionBridge', () => {
  function bridge(over: Partial<BridgeDeps> = {}): {
    b: PermissionBridge
    audits: AuditEntry[]
    deps: BridgeDeps
  } {
    const audits: AuditEntry[] = []
    const deps: BridgeDeps = {
      session: () => ({ project: P, projectName: 'proj', level: 'careful' }),
      ask: vi.fn(async () => true),
      dismiss: vi.fn(),
      present: () => true,
      onPending: vi.fn(),
      audit: (e) => audits.push(e),
      now: () => 1000,
      ...over
    }
    return { b: new PermissionBridge(deps), audits, deps }
  }
  const req = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: P,
    ...extra
  })
  const signal = (): AbortSignal => new AbortController().signal
  const behavior = (o: Record<string, unknown>): unknown =>
    ((o.hookSpecificOutput as Record<string, unknown>).decision as Record<string, unknown>).behavior

  it('approves by policy without asking and audits it', async () => {
    const { b, audits, deps } = bridge()
    const out = await b.handle('cc_a1234', req('npm test'), signal())
    expect(behavior(out)).toBe('allow')
    expect(deps.ask).not.toHaveBeenCalled()
    expect(audits[0]).toMatchObject({ origin: 'claude-code', decision: 'auto', result: 'ok' })
  })

  it('asks the user and passes the answer on', async () => {
    const { b, deps } = bridge({ ask: vi.fn(async () => false) })
    const out = await b.handle('cc_a1234', req('npm install x'), signal())
    expect(behavior(out)).toBe('deny')
    expect(deps.onPending).toHaveBeenCalledWith(
      'cc_a1234',
      expect.objectContaining({ what: 'npm install x' })
    )
    expect(deps.onPending).toHaveBeenLastCalledWith('cc_a1234', null)
  })

  it('"always allow this" returns the CLI’s own suggestions', async () => {
    const { b } = bridge({ ask: () => new Promise(() => {}) })
    const sugg = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }
    ]
    const p = b.handle('cc_a1234', req('npm install x', { permission_suggestions: sugg }), signal())
    await Promise.resolve()
    expect(b.list()).toHaveLength(1)
    expect(b.answer('always')).toBe(true)
    const out = await p
    expect((out.hookSpecificOutput as { decision: unknown }).decision).toEqual({
      behavior: 'allow',
      updatedPermissions: sugg
    })
  })

  it('never gives "always" to the hard list and denies it when nobody is there', async () => {
    const { b } = bridge({ ask: () => new Promise(() => {}) })
    const p = b.handle(
      'cc_a1234',
      req('git push --force', { permission_suggestions: [{}] }),
      signal()
    )
    await Promise.resolve()
    b.answer('always')
    expect((await p).hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    })
    const away = bridge({ present: () => false })
    const out = await away.b.handle('cc_a1234', req('npm publish'), signal())
    expect(behavior(out)).toBe('deny')
    expect(away.deps.ask).not.toHaveBeenCalled()
    expect(away.audits[0].decision).toBe('blocked')
  })

  it('denies when the CLI hangs up, and ignores unknown sessions', async () => {
    const { b, deps } = bridge({ ask: () => new Promise(() => {}) })
    const ac = new AbortController()
    const p = b.handle('cc_a1234', req('npm install x'), ac.signal)
    ac.abort()
    expect(behavior(await p)).toBe('deny')
    expect(deps.dismiss).toHaveBeenCalled()
    const none = bridge({ session: () => null })
    expect(await none.b.handle('cc_zzzzz', req('x'), signal())).toEqual({})
  })

  it('writes the confirm text with the exact command', () => {
    const text = permissionSummary({
      id: 'perm_1',
      sessionKey: 'cc_a1234',
      projectName: 'proj',
      tool: 'Bash',
      what: 'git push --force',
      reason: 'it is a force push',
      risk: 'high',
      hard: true,
      createdAt: 0
    })
    expect(text).toContain('wants to run: git push --force')
    expect(text).toContain('always needs you')
    expect(text).not.toContain('always allow this')
  })
})
