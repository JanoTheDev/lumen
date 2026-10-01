import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CodingSkillInfo } from '@shared/coding-skills'
import {
  cargoDeps,
  catalogFor,
  detectDependencies,
  npmDeps,
  pyprojectDeps,
  requirementsDeps,
  suggestSkills
} from '../../src/main/coding-skills/detect'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-cs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const skill = (name: string, packages: string[]): CodingSkillInfo => ({
  name,
  title: name,
  description: 'd',
  source: { kind: 'written' },
  packages,
  updatedAt: 0
})

describe('dependency detection', () => {
  it('reads package.json dependencies of every kind', () => {
    const deps = npmDeps(
      JSON.stringify({
        dependencies: { next: '15.2.0', 'better-auth': '^1.3.0' },
        devDependencies: { '@prisma/client': '6.1.0' },
        peerDependencies: { react: '*' }
      })
    )
    expect(deps.map((d) => d.name)).toEqual(['next', 'better-auth', '@prisma/client', 'react'])
    expect(deps[0]).toMatchObject({ ecosystem: 'npm', version: '15.2.0', file: 'package.json' })
    expect(npmDeps('not json')).toEqual([])
  })

  it('reads pyproject (PEP 621 and poetry) and requirements.txt', () => {
    const py = pyprojectDeps(
      [
        '[project]',
        'name = "x"',
        'dependencies = [',
        '  "fastapi[all]>=0.110",',
        '  "SQLAlchemy==2.0.30",',
        ']',
        '[tool.poetry.dependencies]',
        'python = "^3.12"',
        'pydantic = "^2.7"',
        'django = { version = "5.0", optional = true }'
      ].join('\n')
    )
    expect(py.map((d) => d.name)).toEqual(['fastapi', 'sqlalchemy', 'pydantic', 'django'])
    expect(py.find((d) => d.name === 'fastapi')?.version).toBe('>=0.110')
    expect(py.find((d) => d.name === 'django')?.version).toBe('5.0')
    const req = requirementsDeps(
      '# comment\nflask==3.0\n-r other.txt\nrequests>=2 ; python_version>"3"\n'
    )
    expect(req.map((d) => d.name)).toEqual(['flask', 'requests'])
  })

  it('reads Cargo.toml dependency tables', () => {
    const deps = cargoDeps(
      [
        '[package]',
        'name = "x"',
        'version = "0.1.0"',
        '[dependencies]',
        'tokio = { version = "1.38", features = ["full"] }',
        'axum = "0.7"',
        '[dev-dependencies]',
        'insta = "1"'
      ].join('\n')
    )
    expect(deps.map((d) => [d.name, d.version])).toEqual([
      ['tokio', '1.38'],
      ['axum', '0.7'],
      ['insta', '1']
    ])
  })

  it('scans the project root and apps/* packages, deduplicated', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { prisma: '6' } }))
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true })
    writeFileSync(
      join(dir, 'apps', 'web', 'package.json'),
      JSON.stringify({ dependencies: { next: '15', prisma: '6' } })
    )
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\nserde = "1"\n')
    const deps = detectDependencies(dir)
    expect(deps.map((d) => `${d.ecosystem}:${d.name}`).sort()).toEqual([
      'cargo:serde',
      'npm:next',
      'npm:prisma'
    ])
    expect(deps.find((d) => d.name === 'next')?.file).toBe('apps/web/package.json')
  })

  it('suggests library skills first, then catalog libraries, minus attached ones', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '15.2', 'better-auth': '1.3', prisma: '6' } })
    )
    const deps = detectDependencies(dir)
    const lib = [skill('nextjs', ['next']), skill('our-auth', ['better-auth'])]
    const s = suggestSkills(deps, lib, ['nextjs'])
    expect(s.map((x) => [x.name, x.inLibrary])).toEqual([
      ['our-auth', true],
      ['prisma', false]
    ])
    expect(s[1]).toMatchObject({
      docsUrl: 'https://www.prisma.io/docs',
      reason: 'prisma 6 in package.json'
    })
    // better-auth is covered by the library skill, so the catalog one is not suggested twice.
    expect(s.some((x) => x.name === 'better-auth')).toBe(false)
  })

  it('finds catalog libraries by spoken name', () => {
    expect(catalogFor('Next.js')?.name).toBe('nextjs')
    expect(catalogFor('next js')?.name).toBe('nextjs')
    expect(catalogFor('better auth')?.name).toBe('better-auth')
    expect(catalogFor('@prisma/client')?.name).toBe('prisma')
    expect(catalogFor('my weird lib')).toBeNull()
  })
})
