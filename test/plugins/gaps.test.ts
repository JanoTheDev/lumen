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
  maskValue,
  shownEnvValue
} from '../../src/main/plugins/convert'
import { findPlugins, type TreeFile } from '../../src/main/plugins/layout'
import { planImport, uniquePluginNamer } from '../../src/main/plugins/plan'
import {
  fetchRemotePlugins,
  githubRepo,
  remoteDownload,
  remoteNotFetched,
  type Fetcher,
  type RemoteDownload
} from '../../src/main/plugins/remote'
import { BUDGET_EXCEEDED, fetchPack } from '../../src/main/packs/fetch'
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

    // A fetcher counts the shared budget down as data arrives (as packs/fetch does).
    const counting: Fetcher = async (_url, o) => {
      o.budget.left -= good.length
      if (o.budget.left < 0) throw new Error(BUDGET_EXCEEDED)
      return good
    }
    const big = await fetchRemotePlugins(many.slice(0, 2), counting, {
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
      { name: 'LEVEL', kind: 'literal', masked: 'info' }
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

describe('MCP server env names that change what runs (review M3)', () => {
  it('leaves out loader and path variables and never stores them', () => {
    const notes: string[] = []
    const r = envOffer(
      {
        NODE_OPTIONS: '--require //evil/s/x.js',
        PATH: '//evil/bin;C:/Windows',
        PYTHONPATH: '//evil/py',
        npm_config_registry: 'https://evil.example',
        DYLD_INSERT_LIBRARIES: 'x',
        ComSpec: 'x.exe',
        LEVEL: 'debug'
      },
      notes
    )
    expect(r.env).toEqual([{ name: 'LEVEL', kind: 'literal', masked: 'debug' }])
    expect(Object.keys(r.envLiterals)).toEqual(['LEVEL'])
    for (const k of ['NODE_OPTIONS', 'PATH', 'PYTHONPATH', 'npm_config_registry', 'ComSpec'])
      expect(notes.join(' | ')).toContain(`${k} can change which program runs`)
    const forged = {
      preview: { env: [{ name: 'NODE_OPTIONS', kind: 'literal' as const, masked: 'x' }] },
      envLiterals: { NODE_OPTIONS: '--require x' }
    } as Parameters<typeof chosenEnv>[0]
    expect(chosenEnv(forged, { keep: ['NODE_OPTIONS'] })).toEqual({})
    expect(chosenEnv(forged, { values: { NODE_OPTIONS: '--require x' } })).toEqual({})
  })

  it('shows plain values in full and masks secret-looking ones', () => {
    const key = ['abc', '1'.repeat(10), 'XYZ'.repeat(4)].join('')
    expect(shownEnvValue('REGION', 'eu-west-1')).toBe('eu-west-1')
    expect(shownEnvValue('API_TOKEN', 'short')).toMatch(/characters\)$/)
    expect(shownEnvValue('ANYTHING', key)).not.toContain(key)
  })
})

describe('plugin folder variables with a default (review L2)', () => {
  it('skips a server whose command or args use ${CLAUDE_…:-x} or $CLAUDE_…', () => {
    const tree = [
      f('.claude-plugin/plugin.json', JSON.stringify({ name: 'p' })),
      f(
        '.mcp.json',
        JSON.stringify({
          mcpServers: {
            a: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT:-//host/s}/server.js'] },
            b: { command: '$CLAUDE_PLUGIN_ROOT/bin/x' },
            c: { command: 'npx', args: ['-y', 'ok-server'] }
          }
        })
      )
    ]
    const p = findPlugins(tree).plugins[0]
    const r = convertPlugin(tree, p)
    expect(r.servers.map((s) => s.input.name)).toEqual(['c'])
    const why = r.skipped.map((s) => `${s.what}: ${s.why}`).join('\n')
    expect(why).toMatch(/connector "a".*runs a program from inside the plugin/)
    expect(why).toMatch(/connector "b".*runs a program from inside the plugin/)
  })
})

describe('more arguments than a skill can take (review L4)', () => {
  it('leaves no {argN} placeholder without a param', () => {
    const body = ['Do $ARGUMENTS.', ...Array.from({ length: 20 }, (_, i) => `$ARGUMENTS[${i}]`)]
    const r = convertBody(body.join(' '))
    const used = [...r.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
    const known = new Set([...r.params, ...(r.usesArgs ? ['arguments'] : [])])
    expect(used.filter((n) => !known.has(n))).toEqual([])
    expect(r.body).toContain('$ARGUMENTS[19]')
    expect(r.notes.join(' ')).toMatch(/more arguments than a Lumen skill can/)
  })
})

describe('two plugins with the same name (review L1)', () => {
  it('get their own names, archives and connector keys', () => {
    const tree = (skill: string, server: string): TreeFile[] => [
      f('.claude-plugin/plugin.json', JSON.stringify({ name: 'x' })),
      f(`skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: Does ${skill}.\n---\nGo.\n`),
      f(
        '.mcp.json',
        JSON.stringify({ mcpServers: { [server]: { command: 'npx', args: [server] } } })
      )
    ]
    const unique = uniquePluginNamer()
    const found = [tree('one', 's1'), tree('two', 's2')].map((t) => {
      const plugin = unique(findPlugins(t).plugins[0])
      return { plugin, converted: convertPlugin(t, plugin) }
    })
    expect(found.map((x) => x.plugin.name)).toEqual(['x', 'x-2'])
    const plan = planImport(found, 'src', { owner: () => 'free' }, [])
    expect(plan.archives.map((a) => a.source)).toEqual(['src::x', 'src::x-2'])
    expect(plan.skills.map((s) => s.preview.name)).toEqual(['one', 'two'])
    const keys = plan.servers.map((s) => s.preview.key)
    expect(new Set(keys).size).toBe(2)
  })
})

describe('remote fetch budget and cancel (review M4)', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    name: `p${i}`,
    entry: {},
    source: { source: 'github', repo: `a/p${i}` }
  }))

  it('stops starting downloads once the shared budget is spent', async () => {
    const calls: number[] = []
    const fetcher: Fetcher = async (_url, o) => {
      calls.push(o.maxBytes)
      o.budget.left -= 1000
      if (o.budget.left < 0) throw new Error(BUDGET_EXCEEDED)
      return Buffer.alloc(0)
    }
    const r = await fetchRemotePlugins(many, fetcher, { maxBytes: 500 })
    // Three workers start at most one download each; none after the budget is gone.
    expect(calls.length).toBeLessThanOrEqual(3)
    expect(calls.every((m) => m <= 500)).toBe(true)
    expect(r.plugins).toEqual([])
    expect(r.skipped).toHaveLength(6)
    for (const s of r.skipped) expect(s.why).toMatch(/too large together/)
  })

  it('hands cancel to running downloads and starts none after it', async () => {
    const stop = new AbortController()
    const seen: AbortSignal[] = []
    const fetcher: Fetcher = (_url, o) => {
      seen.push(o.signal)
      return new Promise((_res, rej) =>
        o.signal.addEventListener('abort', () => rej(new Error('download cancelled')))
      )
    }
    const p = fetchRemotePlugins(many, fetcher, { signal: stop.signal })
    await Promise.resolve()
    stop.abort()
    const r = await p
    expect(seen.length).toBe(3)
    expect(seen.every((s) => s.aborted)).toBe(true)
    expect(r.plugins).toEqual([])
    expect(r.skipped.map((s) => s.why).join(' | ')).toMatch(/cancelled/)

    const none = await fetchRemotePlugins(many, fetcher, { signal: stop.signal })
    expect(seen.length).toBe(3)
    expect(none.skipped).toHaveLength(6)
  })

  it('fetchPack refuses a spent budget or a cancelled signal before connecting', async () => {
    const url = 'https://codeload.github.com/a/b/zip/HEAD'
    await expect(fetchPack(url, { budget: { left: 0 } })).rejects.toThrow(BUDGET_EXCEEDED)
    await expect(fetchPack(url, { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/)
  })

  it('a folder import lists marketplace plugins from other places without fetching', () => {
    const tree = [
      f(
        '.claude-plugin/marketplace.json',
        JSON.stringify({
          name: 'm',
          owner: { name: 'o' },
          plugins: [{ name: 'tidy', source: { source: 'github', repo: 'acme/tool' } }]
        })
      )
    ]
    const r = remoteNotFetched(findPlugins(tree).remote)
    expect(r).toEqual([{ what: 'plugin "tidy"', why: expect.stringMatching(/stays offline/) }])
  })
})
