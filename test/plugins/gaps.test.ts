// Plugin import gaps closed after T45 (no network: zips are built in memory and handed to a
// fake fetcher): marketplace plugins hosted in other GitHub repos, positional and named command
// arguments as skill params, and env values of imported MCP servers (asked for, or the plugin's
// own value shown masked and kept only when ticked).
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  chosenEnv,
  convertBody,
  convertPlugin,
  envOffer,
  hintParts,
  maskValue
} from '../../src/main/plugins/convert'
import { findPlugins, type TreeFile } from '../../src/main/plugins/layout'
import { planImport } from '../../src/main/plugins/plan'
import {
  fetchRemotePlugins,
  githubRepo,
  remoteDownload,
  type RemoteDownload
} from '../../src/main/plugins/remote'
import { zip } from '../../src/main/packs/zip-write'
import { parseSkillFile } from '../../src/main/skills/manifest'

const f = (name: string, text: string): TreeFile => ({ name, data: Buffer.from(text, 'utf8') })
const ok = (src: Record<string, unknown>): RemoteDownload => {
  const r = remoteDownload(src)
  if (!r.ok) throw new Error(r.why)
  return r.download
}
const why = (src: Record<string, unknown>): string => {
  const r = remoteDownload(src)
  return r.ok ? '' : r.why
}

describe('remote marketplace sources', () => {
  it('maps GitHub sources to codeload zips', () => {
    expect(ok({ source: 'github', repo: 'acme/tool' })).toEqual({
      url: 'https://codeload.github.com/acme/tool/zip/HEAD',
      label: 'github acme/tool'
    })
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
    expect(ok({ source: 'github', repo: 'acme/tool', ref: 'v2', sha }).url).toBe(
      `https://codeload.github.com/acme/tool/zip/${sha}`
    )
    expect(ok({ source: 'github', repo: 'acme/tool', ref: 'v2.0.0' }).url).toBe(
      'https://codeload.github.com/acme/tool/zip/v2.0.0'
    )
    expect(ok({ source: 'url', url: 'https://github.com/acme/tool.git', ref: 'main' }).url).toBe(
      'https://codeload.github.com/acme/tool/zip/main'
    )
    expect(ok({ source: 'url', url: 'git@github.com:acme/tool.git' }).url).toBe(
      'https://codeload.github.com/acme/tool/zip/HEAD'
    )
    expect(ok({ source: 'git-subdir', url: 'acme/mono', path: 'tools/fmt' })).toMatchObject({
      url: 'https://codeload.github.com/acme/mono/zip/HEAD',
      subpath: 'tools/fmt'
    })
    expect(
      ok({ source: 'git-subdir', url: 'https://github.com/acme/mono.git', path: './tools/fmt/' })
        .subpath
    ).toBe('tools/fmt')
  })

  it('archives only from the pack hosts, with the sha256 kept', () => {
    const d = ok({
      source: 'archive',
      url: 'https://github.com/acme/tool/releases/download/v1/tool.zip',
      sha256: 'AB'.repeat(32)
    })
    expect(d.sha256).toBe('ab'.repeat(32))
    expect(why({ source: 'archive', url: 'https://artifacts.example.com/x.zip' })).toMatch(
      /artifacts\.example\.com; Lumen only downloads plugins from GitHub/
    )
    expect(why({ source: 'archive', url: 'http://github.com/x.zip' })).toMatch(/only downloads/)
  })

  it('leaves other hosts, npm, command and bad values out with a reason', () => {
    expect(why({ source: 'url', url: 'https://gitlab.example.com/g/tool.git' })).toMatch(
      /git repository on gitlab\.example\.com/
    )
    expect(why({ source: 'url', url: 'acme/tool' })).toMatch(/only downloads plugins from GitHub/)
    expect(why({ source: 'npm', package: '@acme/tool' })).toMatch(/npm/)
    expect(why({ source: 'command', command: 'x' })).toMatch(/never does/)
    expect(why({ source: 'github', repo: 'acme/../x' })).toMatch(/not valid/)
    expect(why({ source: 'github', repo: 'acme/tool', sha: 'abc' })).toMatch(/commit is not valid/)
    expect(why({ source: 'github', repo: 'acme/tool', ref: '../main' })).toMatch(/not valid/)
    expect(why({ source: 'git-subdir', url: 'acme/mono', path: '../up' })).toMatch(/path/)
    expect(why({ source: 'svn' })).toMatch(/not supported/)
    expect(githubRepo('https://github.com/acme/tool/tree/main')).toBeNull()
    expect(githubRepo('https://evil.com/acme/tool')).toBeNull()
  })

  /** A repo zip the way codeload serves it: one top folder. */
  const repoZip = (files: TreeFile[], top = 'tool-main/'): Buffer =>
    zip(files.map((x) => ({ name: `${top}${x.name}`, data: x.data })))

  const remoteMarket = (plugins: unknown[]): TreeFile[] => [
    f(
      '.claude-plugin/marketplace.json',
      JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins })
    )
  ]

  it('fetches remote plugins once per download and converts them', async () => {
    const mono = repoZip(
      [
        f(
          'tools/fmt/.claude-plugin/plugin.json',
          JSON.stringify({ name: 'fmt', version: '1.2.0' })
        ),
        f('tools/fmt/commands/format-file.md', 'Format $0.\n'),
        f(
          'tools/lint/skills/lint-all/SKILL.md',
          '---\nname: lint-all\ndescription: Lint.\n---\nGo.\n'
        )
      ],
      'mono-HEAD/'
    )
    const tool = repoZip([f('skills/tidy-up/SKILL.md', '---\ndescription: Tidy.\n---\nTidy.\n')])
    const calls: string[] = []
    const fetcher = async (url: string): Promise<Buffer> => {
      calls.push(url)
      if (url.includes('/acme/mono/')) return mono
      if (url.includes('/acme/tool/')) return tool
      throw new Error('download failed (HTTP 404)')
    }
    const tree = remoteMarket([
      { name: 'fmt', source: { source: 'git-subdir', url: 'acme/mono', path: 'tools/fmt' } },
      { name: 'lint', source: { source: 'git-subdir', url: 'acme/mono', path: 'tools/lint' } },
      { name: 'tidy', description: 'Tidies', source: { source: 'github', repo: 'acme/tool' } },
      { name: 'gone', source: { source: 'github', repo: 'acme/gone' } },
      { name: 'empty', source: { source: 'git-subdir', url: 'acme/mono', path: 'nope' } },
      { name: 'lab', source: { source: 'url', url: 'https://gitlab.com/a/b.git' } }
    ])
    const found = findPlugins(tree)
    expect(found.plugins).toEqual([])
    const r = await fetchRemotePlugins(found.remote, fetcher)
    // The monorepo is downloaded once for its three entries.
    expect(calls.filter((u) => u.includes('/acme/mono/'))).toHaveLength(1)
    expect(r.plugins.map((p) => [p.plugin.name, p.plugin.version ?? ''])).toEqual([
      ['fmt', '1.2.0'],
      ['lint', ''],
      ['tidy', '']
    ])
    expect(r.plugins[2].plugin.description).toBe('Tidies')
    const skipped = r.skipped.map((s) => `${s.what}: ${s.why}`).join('\n')
    expect(skipped).toMatch(/"lab": it is a git repository on gitlab\.com/)
    expect(skipped).toMatch(
      /"gone": it could not be downloaded from github acme\/gone \(download failed/
    )
    expect(skipped).toMatch(/"empty": its folder is empty or missing/)

    const plan = planImport(
      r.plugins.map((p) => ({ plugin: p.plugin, converted: convertPlugin(p.files, p.plugin) })),
      'https://codeload.github.com/acme/market/zip/HEAD',
      { owner: () => 'free' },
      [],
      r.skipped
    )
    expect(plan.skills.map((s) => s.preview.name).sort()).toEqual([
      'format-file',
      'lint-all',
      'tidy-up'
    ])
    expect(plan.archives.map((a) => a.source)).toEqual([
      'https://codeload.github.com/acme/market/zip/HEAD::fmt',
      'https://codeload.github.com/acme/market/zip/HEAD::lint',
      'https://codeload.github.com/acme/market/zip/HEAD::tidy'
    ])
  })

  it('checks an archive sha256, the zip limits, the fetch cap and the total size', async () => {
    const good = zip([f('skills/a-b/SKILL.md', '---\ndescription: A.\n---\nA.\n')])
    const digest = createHash('sha256').update(good).digest('hex')
    const url = 'https://github.com/acme/t/releases/download/v1/t.zip'
    const r = await fetchRemotePlugins(
      [
        { name: 'right', entry: {}, source: { source: 'archive', url, sha256: digest } },
        { name: 'wrong', entry: {}, source: { source: 'archive', url, sha256: '0'.repeat(64) } }
      ],
      async () => good
    )
    expect(r.plugins.map((p) => p.plugin.name)).toEqual(['right'])
    expect(r.skipped[0].why).toMatch(/does not match its sha256/)

    const notZip = await fetchRemotePlugins(
      [{ name: 'x', entry: {}, source: { source: 'github', repo: 'a/b' } }],
      async () => Buffer.from('not a zip')
    )
    expect(notZip.skipped[0].why).toMatch(/not a usable download/)

    const many = Array.from({ length: 4 }, (_, i) => ({
      name: `p${i}`,
      entry: {},
      source: { source: 'github', repo: `a/p${i}` }
    }))
    const capped = await fetchRemotePlugins(many, async () => good, { max: 2 })
    expect(capped.plugins).toHaveLength(2)
    expect(capped.skipped.map((s) => s.what)).toEqual(['plugin "p2"', 'plugin "p3"'])

    const big = await fetchRemotePlugins(many.slice(0, 2), async () => good, {
      maxBytes: good.length + 1
    })
    expect(big.plugins).toHaveLength(1)
    expect(big.skipped[0].why).toMatch(/too large together/)
  })
})

describe('command arguments', () => {
  it('maps $N and $ARGUMENTS[N] (0-based) to arg1, arg2 …', () => {
    const r = convertBody('Fix $0 on $ARGUMENTS[1], then $0 again. All: $ARGUMENTS')
    expect(r.body).toBe('Fix {arg1} on {arg2}, then {arg1} again. All: {arguments}')
    expect(r.params).toEqual(['arg1', 'arg2'])
    expect(r.usesArgs).toBe(true)
  })

  it('leaves prices, escaped dollars and long numbers alone', () => {
    const r = convertBody('It costs $5.00 or $10, not \\$1; pay $2,50 now.')
    expect(r.body).toBe('It costs $5.00 or $10, not \\$1; pay $2,50 now.')
    expect(r.params).toEqual([])
  })

  it('maps named arguments from the header and describes params from the hint', () => {
    const text =
      '---\ndescription: Migrate a component\narguments: [issue, branch, bad-name]\nargument-hint: "[issue] [branch]"\n---\nMigrate $issue from $branch ($1).\n'
    const tree = [f('commands/migrate.md', text)]
    const plugin = findPlugins(tree).plugins[0]
    const s = convertPlugin(tree, plugin).skills[0]
    const parsed = parseSkillFile(s.files[0].data.toString('utf8'))
    expect(parsed.warnings).toEqual([])
    expect(parsed.body).toBe('Migrate {issue} from {branch} ({arg2}).')
    expect(parsed.manifest.params).toEqual({
      arg2: { type: 'string', default: '', description: 'Value 2 of the request: branch' },
      issue: { type: 'string', default: '', description: 'Value 1 of the request: issue' },
      branch: { type: 'string', default: '', description: 'Value 2 of the request: branch' }
    })
    expect(s.preview.notes.join(' | ')).toMatch(/could not take by name: bad-name/)
    expect(hintParts('[pr-number] <priority> extra')).toEqual(['pr-number', 'priority', 'extra'])
  })
})

describe('MCP server env', () => {
  it('asks for placeholders, masks literal values and keeps them only when ticked', () => {
    const secret = ['tok', 'A'.repeat(20)].join('_')
    const notes: string[] = []
    const r = envOffer(
      {
        API_KEY: '${SEARCH_KEY}',
        TOKEN: secret,
        LEVEL: '${LEVEL:-info}',
        DATA: '${CLAUDE_PLUGIN_DATA}/db',
        'bad-name': 'x',
        NUM: 3
      },
      notes
    )
    expect(r.env).toEqual([
      { name: 'API_KEY', kind: 'ask', placeholder: 'SEARCH_KEY' },
      { name: 'TOKEN', kind: 'literal', masked: 'to•••••••• (24 characters)' },
      { name: 'LEVEL', kind: 'literal', masked: '•••• (4 characters)' }
    ])
    expect(r.envNeeded).toEqual(['API_KEY'])
    // The preview never carries a literal value.
    expect(JSON.stringify(r.env)).not.toContain(secret)
    expect(notes.join(' | ')).toMatch(/DATA pointed into the plugin folder/)
    expect(notes.join(' | ')).toMatch(/type API_KEY here/)

    const offer = { preview: { env: r.env }, envLiterals: r.envLiterals } as Parameters<
      typeof chosenEnv
    >[0]
    expect(chosenEnv(offer, undefined)).toEqual({})
    expect(chosenEnv(offer, { keep: ['LEVEL'], values: { API_KEY: '  typed  ' } })).toEqual({
      LEVEL: 'info',
      API_KEY: 'typed'
    })
    expect(
      chosenEnv(offer, { keep: ['TOKEN', 'API_KEY', 'OTHER'], values: { OTHER: 'x' } })
    ).toEqual({ TOKEN: secret })
    expect(chosenEnv(offer, { values: { API_KEY: '' } })).toEqual({})
    expect(maskValue('ab')).toBe('•••• (2 characters)')
  })
})
