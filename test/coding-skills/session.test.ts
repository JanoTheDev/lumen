import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_CODE_DEFAULTS, type ClaudeProject } from '@shared/claude-code'
import { buildArgs } from '../../src/main/claude-code/cli'
import { ClaudeCopilot } from '../../src/main/claude-code/copilot'
import { ClaudeSession, type TurnEnd } from '../../src/main/claude-code/session'
import { CodingSkillLibrary } from '../../src/main/coding-skills/library'
import { fakeSpawn } from '../claude-code/fake'

let dir: string
let argsFile: string
const live: { stop(): void }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-cs-'))
  argsFile = join(dir, 'args.ndjson')
})

afterEach(async () => {
  for (const s of live.splice(0)) s.stop()
  // Retired and stopped fakes exit on their own once stdin closes.
  await new Promise((r) => setTimeout(r, 400))
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function spawned(): string[][] {
  if (!existsSync(argsFile)) return []
  return readFileSync(argsFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { args: string[] }).args)
}

function nextTurn(s: ClaudeSession): Promise<TurnEnd> {
  return new Promise((resolve) => s.once('turn', resolve))
}

describe('session args for coding skills', () => {
  it('passes each plugin folder as --plugin-dir and refuses relative ones', () => {
    const a = join(dir, 'p1')
    expect(buildArgs({ pluginDirs: [a, join(dir, 'p2')] })).toEqual(
      expect.arrayContaining(['--plugin-dir', a, '--plugin-dir', join(dir, 'p2')])
    )
    expect(() => buildArgs({ pluginDirs: ['rel/dir'] })).toThrow(/refused/)
    expect(() => buildArgs({ pluginDirs: ['--dangerously-skip-permissions'] })).toThrow(/refused/)
    expect(buildArgs({})).not.toContain('--plugin-dir')
  })

  it('recycle restarts an idle session with fresh plugin folders and the same CLI session', async () => {
    let dirs = [join(dir, 'skills-a')]
    const s = new ClaudeSession(
      {
        id: 'cc_rec1',
        project: dir,
        projectName: 'proj',
        cliPath: 'claude.exe',
        autopilot: 'careful',
        args: {},
        spawnArgs: () => ({ pluginDirs: dirs }),
        env: { FAKE_ARGS_FILE: argsFile }
      },
      { spawn: fakeSpawn(), now: () => Date.now() }
    )
    live.push(s)
    let t = nextTurn(s)
    s.send('one')
    await t
    const id = s.view.sessionId!
    dirs = [join(dir, 'skills-b')]
    expect(s.recycle()).toBe(true)
    // Still counts as running (autopilot keeps relaying), the next turn resumes.
    expect(s.alive).toBe(true)
    t = nextTurn(s)
    s.send('two')
    expect((await t).text).toBe('done: two')
    const runs = spawned()
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual(expect.arrayContaining(['--plugin-dir', join(dir, 'skills-a')]))
    expect(runs[1]).toEqual(
      expect.arrayContaining(['--plugin-dir', join(dir, 'skills-b'), '--resume', id])
    )
    expect(s.view.sessionId).toBe(id)
  }, 15_000)

  it('a busy session finishes its turn before it restarts', async () => {
    const s = new ClaudeSession(
      {
        id: 'cc_rec2',
        project: dir,
        projectName: 'proj',
        cliPath: 'claude.exe',
        autopilot: 'careful',
        args: {},
        env: { FAKE_ARGS_FILE: argsFile }
      },
      { spawn: fakeSpawn(), now: () => Date.now() }
    )
    live.push(s)
    let t = nextTurn(s)
    s.send('first')
    await t
    t = nextTurn(s)
    s.send('second')
    s.recycle()
    expect((await t).text).toBe('done: second')
    t = nextTurn(s)
    s.send('third')
    await t
    expect(spawned()).toHaveLength(2)
  }, 15_000)
})

describe('copilot + library: skills reach the session, never the repo', () => {
  it('builds the plugin folder at spawn and reloads it after an attach', async () => {
    const project = join(dir, 'proj')
    mkdirSync(project)
    writeFileSync(join(project, 'package.json'), '{"dependencies":{"next":"15"}}')
    const lib = new CodingSkillLibrary(join(dir, 'lumen', 'coding-skills'))
    lib.save({
      info: {
        name: 'nextjs',
        title: 'Next.js',
        description: 'd',
        source: { kind: 'written' },
        packages: ['next']
      },
      skillMd: '---\nname: nextjs\ndescription: "Next.js notes"\n---\n\nUse the App Router.\n'
    })
    lib.attach(project, ['nextjs'])
    const runDir = join(dir, 'lumen', 'run')
    const p: ClaudeProject = { path: project, name: 'proj', source: 'user' }
    let n = 0
    const c = new ClaudeCopilot({
      settings: () => ({ ...CLAUDE_CODE_DEFAULTS }),
      cliPath: async () => 'claude.exe',
      projects: () => [p],
      spawn: (cmd, cwd, env) => fakeSpawn()(cmd, cwd, { ...env, FAKE_ARGS_FILE: argsFile }),
      hookBase: () => null,
      writeSettings: () => '',
      removeSettings: (key) =>
        rmSync(join(runDir, `${key}-skills`), { recursive: true, force: true }),
      pluginDirs: (key, proj) => {
        const d = lib.buildPluginDir(join(runDir, `${key}-skills`), proj)
        return d ? [d] : []
      },
      decide: async () => {
        throw new Error('no')
      },
      claudeMd: () => undefined,
      notify: () => {},
      audit: () => {},
      saved: () => [],
      remember: () => {},
      changed: () => {},
      now: () => Date.now(),
      newId: () => `cc_s${++n}`,
      log: () => {}
    })
    live.push({ stop: () => c.shutdown() })
    const v = await c.open(p, { prompt: 'hello' })
    const pluginDir = join(runDir, `${v.id}-skills`)
    const until = async (k: number): Promise<void> => {
      for (let i = 0; i < 200 && (c.get(v.id)?.turns ?? 0) < k; i++)
        await new Promise((r) => setTimeout(r, 20))
    }
    await until(1)
    expect(spawned()[0]).toEqual(expect.arrayContaining(['--plugin-dir', pluginDir]))
    expect(existsSync(join(pluginDir, 'skills', 'nextjs', 'SKILL.md'))).toBe(true)

    // Dropping every skill: the next spawn passes no --plugin-dir.
    lib.detach(project, 'nextjs')
    expect(c.reloadSkills([project]).map((x) => x.id)).toEqual([v.id])
    c.send(v.id, 'again')
    await until(2)
    const runs = spawned()
    expect(runs).toHaveLength(2)
    expect(runs[1]).not.toContain('--plugin-dir')
    expect(existsSync(pluginDir)).toBe(false)
    // The project folder holds only what the test put there.
    expect(existsSync(join(project, '.claude'))).toBe(false)
    c.close(v.id)
  }, 20_000)
})
