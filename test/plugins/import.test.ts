// Claude Code plugin import with fixture plugins (no network): layout discovery (marketplace,
// single plugin, bare skills), conversion of skills / commands / output styles / .mcp.json,
// what is left out (hooks, agents, scripts), renaming on clashes, and the install through the
// skill installer with trust pinned to source + content.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertBody, convertPlugin } from '../../src/main/plugins/convert'
import { findPlugins, stripTop, type TreeFile } from '../../src/main/plugins/layout'
import { planImport, type NameOwner } from '../../src/main/plugins/plan'
import { readTree, scanClaudeHome, readClaudeHome } from '../../src/main/plugins/sources'
import { installArchive, previewArchive } from '../../src/main/skills/manage'
import { parseSkillFile } from '../../src/main/skills/manifest'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { tempDir } from '../helpers/fixtures'

const f = (name: string, text: string): TreeFile => ({ name, data: Buffer.from(text, 'utf8') })

/** A marketplace repo as GitHub zips it: one top folder, two plugins, one elsewhere. */
function marketplace(skillText = 'Review the open pull request: $ARGUMENTS'): TreeFile[] {
  const top = 'acme-plugins-main/'
  return [
    f(
      `${top}.claude-plugin/marketplace.json`,
      JSON.stringify({
        name: 'acme',
        owner: { name: 'Acme' },
        plugins: [
          { name: 'dev-tools', source: './plugins/dev-tools', description: 'Dev helpers' },
          { name: 'remote-one', source: { source: 'github', repo: 'acme/remote-one' } }
        ]
      })
    ),
    f(
      `${top}plugins/dev-tools/.claude-plugin/plugin.json`,
      JSON.stringify({
        name: 'dev-tools',
        version: '2.1.0',
        author: { name: 'Acme' },
        license: 'MIT'
      })
    ),
    f(
      `${top}plugins/dev-tools/skills/pr-review/SKILL.md`,
      `---\nname: pr-review\ndescription: Reviews a pull request.\nallowed-tools: Bash(git:*) Read\ncontext: fork\nmodel: opus\nargument-hint: [pr-number]\n---\n${skillText}\nStatus: !\`git status\`\n`
    ),
    f(`${top}plugins/dev-tools/skills/pr-review/reference/checklist.md`, '- tests\n'),
    f(`${top}plugins/dev-tools/skills/pr-review/scripts/run.py`, 'print(1)\n'),
    f(`${top}plugins/dev-tools/skills/pr-review/data.json`, '{not json'),
    f(
      `${top}plugins/dev-tools/commands/fix-issue.md`,
      '---\ndescription: Fix a GitHub issue\n---\nFix issue $ARGUMENTS and $1.\n'
    ),
    f(`${top}plugins/dev-tools/commands/go.md`, 'Just go.\n'),
    f(
      `${top}plugins/dev-tools/output-styles/pirate.md`,
      '---\nname: Pirate\ndescription: Talks like a pirate\nkeep-coding-instructions: true\n---\nSay arr.\n'
    ),
    f(
      `${top}plugins/dev-tools/.mcp.json`,
      JSON.stringify({
        mcpServers: {
          db: { command: '${CLAUDE_PLUGIN_ROOT}/bin/db', args: [] },
          search: {
            command: 'npx',
            args: ['-y', 'search-mcp', '--level', '${LEVEL:-info}'],
            env: { API_KEY: '${SEARCH_KEY}', MODE: 'fast' }
          },
          tracker: {
            type: 'http',
            url: 'https://mcp.tracker.example.com/mcp',
            headers: { Authorization: 'Bearer ${TRACKER_TOKEN}', 'X-Team': 'a' }
          },
          old: { type: 'sse', url: 'https://old.example.com/sse' }
        }
      })
    ),
    f(`${top}plugins/dev-tools/hooks/hooks.json`, '{"hooks":{}}'),
    f(`${top}plugins/dev-tools/agents/reviewer.md`, '---\nname: reviewer\n---\nx'),
    f(`${top}README.md`, '# Acme')
  ]
}

const free: NameOwner = { owner: () => 'free' }

function convertAll(files: TreeFile[]): ReturnType<typeof planImport> {
  const tree = stripTop(files)
  const r = findPlugins(tree)
  const found = r.plugins.map((plugin) => ({ plugin, converted: convertPlugin(tree, plugin) }))
  return planImport(found, 'https://codeload.github.com/acme/plugins/zip/HEAD', free, [], r.skipped)
}

describe('layout', () => {
  it('reads a marketplace and hands plugins that live elsewhere to the remote fetch', () => {
    const r = findPlugins(stripTop(marketplace()))
    expect(r.plugins.map((p) => [p.name, p.prefix, p.version])).toEqual([
      ['dev-tools', 'plugins/dev-tools/', '2.1.0']
    ])
    expect(r.skipped).toEqual([])
    expect(r.remote).toEqual([
      {
        name: 'remote-one',
        entry: { name: 'remote-one', source: { source: 'github', repo: 'acme/remote-one' } },
        source: { source: 'github', repo: 'acme/remote-one' }
      }
    ])
  })

  it('finds a single plugin and bare skill folders', () => {
    expect(findPlugins([f('skills/a/SKILL.md', 'x')]).plugins).toHaveLength(1)
    const bare = findPlugins([f('tidy/SKILL.md', 'x'), f('other/SKILL.md', 'y')])
    expect(bare.plugins[0]).toMatchObject({ name: 'skills', prefix: '' })
    expect(findPlugins([f('notes.txt', 'x')]).plugins).toEqual([])
  })
})

describe('conversion', () => {
  it('skills keep Lumen least privilege and say what was dropped', () => {
    const plan = convertAll(marketplace())
    const pr = plan.skills.find((s) => s.preview.name === 'pr-review')!
    const md = pr.skill.files[0].data.toString('utf8')
    const parsed = parseSkillFile(md)
    expect(parsed.warnings).toEqual([])
    expect(parsed.manifest).toMatchObject({
      name: 'pr-review',
      version: '2.1.0',
      author: 'Acme',
      license: 'MIT',
      context: 'foreground',
      permissions: { input: false, network: [], connectors: [], risky: false }
    })
    expect(parsed.manifest.model).toBeUndefined()
    expect(parsed.manifest.params.arguments).toMatchObject({ type: 'string', default: '' })
    expect(parsed.body).toContain('Review the open pull request: {arguments}')
    // The load-time shell command stays as text and never runs.
    expect(parsed.body).toContain('Status: `git status`')
    const notes = pr.preview.notes.join(' | ')
    expect(notes).toMatch(/tool permissions are not carried over/)
    expect(notes).toMatch(/subagent/)
    expect(notes).toMatch(/model choice is dropped/)
    expect(notes).toMatch(/never runs them/)
    expect(notes).toMatch(/1 script file\(s\) left out/)
    expect(notes).toMatch(/1 unreadable JSON/)
    expect(pr.skill.files.map((x) => x.name)).toEqual(['SKILL.md', 'reference/checklist.md'])
  })

  it('commands become skills with a trigger when the name has two words', () => {
    const plan = convertAll(marketplace())
    const fix = plan.skills.find((s) => s.preview.name === 'fix-issue')!
    expect(fix.preview).toMatchObject({ from: 'command', triggers: ['fix issue'], kind: 'task' })
    expect(fix.preview.notes.join(' ')).toMatch(/values you can give: arg2/)
    const fixMd = parseSkillFile(fix.skill.files[0].data.toString())
    expect(fixMd.body).toContain('Fix issue {arguments} and {arg2}.')
    expect(Object.keys(fixMd.manifest.params)).toEqual(['arguments', 'arg2'])
    const go = plan.skills.find((s) => s.preview.name === 'go')!
    expect(go.preview.triggers).toEqual([])
    expect(parseSkillFile(go.skill.files[0].data.toString()).manifest.description).toBe('Just go.')
  })

  it('output styles become reply styles', () => {
    const plan = convertAll(marketplace())
    const pirate = plan.skills.find((s) => s.preview.name === 'pirate')!
    expect(pirate.preview).toMatchObject({ from: 'output-style', kind: 'style' })
    expect(parseSkillFile(pirate.skill.files[0].data.toString()).manifest.kind).toBe('style')
  })

  it('MCP servers are offered with their exact command; plugin programs and SSE are not', () => {
    const plan = convertAll(marketplace())
    expect(plan.servers.map((s) => s.preview.name)).toEqual(['search', 'tracker'])
    const search = plan.servers[0]
    expect(search.preview).toMatchObject({
      id: 'search',
      transport: 'stdio',
      commandLine: 'npx -y search-mcp --level info',
      envNeeded: ['API_KEY']
    })
    expect(search.offer.input).not.toHaveProperty('env')
    expect(search.offer.envLiterals).toEqual({ MODE: 'fast' })
    expect(search.preview.env).toEqual([
      { name: 'API_KEY', kind: 'ask', placeholder: 'SEARCH_KEY' },
      { name: 'MODE', kind: 'literal', masked: '•••• (4 characters)' }
    ])
    expect(plan.servers[1].preview).toMatchObject({ transport: 'http', tokenNeeded: true })
    expect(plan.servers[1].preview.notes.join(' ')).toMatch(/X-Team/)
    const skipped = plan.skipped.map((s) => `${s.what}: ${s.why}`).join('\n')
    expect(skipped).toMatch(/connector "db".*inside the plugin/)
    expect(skipped).toMatch(/connector "old".*SSE/)
    expect(skipped).toMatch(/hooks \(dev-tools\): hooks run commands on your PC/)
    expect(skipped).toMatch(/subagents/)
  })

  it('convertBody leaves plain text alone', () => {
    expect(convertBody('Hello $name and $$ world')).toMatchObject({ usesArgs: false, notes: [] })
  })
})

describe('plan', () => {
  it('renames on clashes with someone else, keeps names from the same source', () => {
    const tree = stripTop(marketplace())
    const plugin = findPlugins(tree).plugins[0]
    const found = [{ plugin, converted: convertPlugin(tree, plugin) }]
    const names: NameOwner = {
      owner: (n, src) =>
        n === 'go' ? 'other' : n === 'pr-review' && src === 'S' ? 'same-source' : 'free'
    }
    const plan = planImport(found, 'S', names, [{ id: 'search', commandLine: 'npx other' }])
    const list = plan.skills.map((s) => s.preview.name)
    expect(list).toContain('pr-review')
    expect(list).toContain('dev-tools-go')
    expect(list).not.toContain('go')
    // The connector id is taken by a different server: a free id instead.
    expect(plan.servers[0].preview.id).toBe('search-2')
    const again = planImport(found, 'S', names, [
      { id: 'search', commandLine: 'npx -y search-mcp --level info' }
    ])
    expect(again.servers[0].preview).toMatchObject({ id: 'search', exists: 'same' })
  })

  it('makes the same archive for the same content', () => {
    const a = convertAll(marketplace()).archives
    const b = convertAll(marketplace()).archives
    expect(a).toHaveLength(1)
    expect(a[0].archive.equals(b[0].archive)).toBe(true)
    const c = convertAll(marketplace('Something else')).archives
    expect(a[0].archive.equals(c[0].archive)).toBe(false)
  })
})

describe('install', () => {
  let t: ReturnType<typeof tempDir>
  let reg: SkillRegistry
  let state: SkillStateStore
  beforeEach(() => {
    t = tempDir()
    state = new SkillStateStore(join(t.dir, 'state.json'))
    reg = new SkillRegistry(
      { builtin: join(t.dir, 'builtin'), appPacks: join(t.dir, 'app'), user: join(t.dir, 'user') },
      { state }
    ).load()
  })
  afterEach(() => t.cleanup())

  it('installs as untrusted community skills; same content keeps trust, new content resets it', () => {
    const plan = convertAll(marketplace())
    const { archive, source } = plan.archives[0]
    const r = installArchive(reg, archive, source)
    expect(r.ok).toBe(true)
    expect(reg.get('pr-review')!.source).toBe(source)
    expect(reg.trustOf(reg.get('pr-review')!)).toBe('community-untrusted')
    expect(reg.styles().map((s) => s.manifest.name)).toEqual(['pirate'])
    state.setTrusted('pr-review', true, reg.get('pr-review')!.pin)
    expect(reg.trustOf(reg.get('pr-review')!)).toBe('community-trusted')

    const same = previewArchive(
      reg,
      convertAll(marketplace()).archives[0].archive,
      undefined,
      source
    )
    expect(same.ok && same.skills.find((s) => s.name === 'pr-review')).toMatchObject({
      updates: true
    })
    expect(same.ok && same.skills.find((s) => s.name === 'pr-review')!.resetsTrust).toBeUndefined()

    const changed = convertAll(marketplace('Changed body')).archives[0].archive
    const p = previewArchive(reg, changed, undefined, source)
    expect(p.ok && p.skills.find((s) => s.name === 'pr-review')!.resetsTrust).toBe(true)
    expect(installArchive(reg, changed, source).ok).toBe(true)
    expect(reg.trustOf(reg.get('pr-review')!)).toBe('community-untrusted')
  })
})

describe('local sources', () => {
  it('reads a folder and the Claude Code home without settings.json', () => {
    const t = tempDir()
    try {
      const home = t.dir
      mkdirSync(join(home, 'skills', 'tidy'), { recursive: true })
      writeFileSync(
        join(home, 'skills', 'tidy', 'SKILL.md'),
        '---\nname: tidy\ndescription: Tidy.\n---\nDo.\n'
      )
      mkdirSync(join(home, 'commands'), { recursive: true })
      writeFileSync(join(home, 'commands', 'ship-it.md'), 'Ship it.\n')
      writeFileSync(join(home, 'settings.json'), '{"hooks":{"Stop":[]}}')
      mkdirSync(join(home, 'skills', 'node_modules', 'x'), { recursive: true })
      writeFileSync(join(home, 'skills', 'node_modules', 'x', 'SKILL.md'), 'x')
      expect(scanClaudeHome(home)).toMatchObject({
        found: true,
        skills: 1,
        commands: 1,
        plugins: 0
      })
      const { trees } = readClaudeHome(home)
      expect(trees).toHaveLength(1)
      expect(trees[0].files.map((x) => x.name).sort()).toEqual([
        'commands/ship-it.md',
        'skills/tidy/SKILL.md'
      ])
      expect(readTree(join(home, 'skills')).map((x) => x.name)).toEqual(['tidy/SKILL.md'])
    } finally {
      t.cleanup()
    }
  })
})
