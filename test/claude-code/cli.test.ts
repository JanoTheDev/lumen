import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildArgs, command, resolveShim } from '../../src/main/claude-code/cli'
import { killTree, type KillRunner } from '../../src/main/claude-code/kill-tree'

describe('buildArgs', () => {
  it('accepts any absolute settings path (non-ASCII, & % ! in the user name)', () => {
    for (const p of [
      'C:\\Users\\Jürgen\\.ai-overlay\\claude-code\\run\\cc_x.json',
      'C:\\Users\\José\\.ai-overlay\\run\\cc_x.json',
      'C:\\Users\\王小明\\.ai-overlay\\run\\cc_x.json',
      'C:\\Users\\A&B 100%!\\.ai-overlay\\run\\cc_x.json'
    ])
      expect(buildArgs({ settingsPath: p })).toEqual(expect.arrayContaining(['--settings', p]))
  })

  it('refuses relative paths, control characters and values that read as flags', () => {
    expect(() => buildArgs({ settingsPath: 'relative\\x.json' })).toThrow(/refused/)
    expect(() => buildArgs({ settingsPath: 'C:\\x\n--y' })).toThrow(/refused/)
    expect(() => buildArgs({ resume: '--settings' })).toThrow(/refused/)
    expect(() => buildArgs({ model: '--permission-mode' })).toThrow(/refused/)
    expect(() => buildArgs({ allowedTools: ['--permission-mode'] })).toThrow(/refused/)
  })
})

describe('command', () => {
  it('quotes every argument for cmd.exe and refuses what cmd.exe would expand', () => {
    const shim = 'C:\\no-such-dir\\npm\\claude.cmd'
    const ok = command(shim, ['--settings', 'C:\\A&B (x)\\s.json'])
    // `&` and parentheses inside quotes are literal for cmd.exe.
    expect(ok.args[3]).toBe(
      '""C:\\no-such-dir\\npm\\claude.cmd" "--settings" "C:\\A&B (x)\\s.json""'
    )
    for (const bad of ['C:\\100%\\s.json', 'a"b', 'x!y', 'a^b', 'C:\\dir\\'])
      expect(() => command(shim, ['--settings', bad]), bad).toThrow(/refused/)
  })
})

describe('resolveShim', () => {
  let dir: string
  let shim: string
  const pkg = (): string => join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-shim-'))
    shim = join(dir, 'claude.cmd')
    mkdirSync(join(pkg(), 'bin'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const NPM_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
  ].join('\r\n')

  it('runs the npm shim’s cli.js with node, no shell, so a kill reaches the CLI', () => {
    const js = join(pkg(), 'cli.js')
    writeFileSync(js, '')
    writeFileSync(shim, NPM_SHIM)
    expect(resolveShim(shim)).toEqual({ file: 'node', pre: [js] })
    writeFileSync(join(dir, 'node.exe'), '')
    const settings = 'C:\\Users\\Jürgen\\100%\\s.json'
    expect(command(shim, ['-p', '--settings', settings])).toEqual({
      file: join(dir, 'node.exe'),
      args: [js, '-p', '--settings', settings],
      verbatim: false
    })
  })

  it('runs an exe the shim starts directly', () => {
    const exe = join(pkg(), 'bin', 'claude.exe')
    writeFileSync(exe, '')
    writeFileSync(
      shim,
      '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
    )
    expect(resolveShim(shim)).toEqual({ file: exe, pre: [] })
  })

  it('gives up on targets outside the shim folder, missing files and other shapes', () => {
    for (const text of [
      '@"%~dp0\\..\\evil.exe" %*\r\n',
      '@"%~dp0\\missing.js" %*\r\n',
      '@node "C:\\x\\cli.js" %*\r\n',
      '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js"\r\n'
    ]) {
      writeFileSync(join(pkg(), 'cli.js'), '')
      writeFileSync(shim, text)
      expect(resolveShim(shim), text).toBeNull()
    }
    expect(resolveShim(join(dir, 'nope.cmd'))).toBeNull()
  })
})

describe('killTree', () => {
  const runner = (): KillRunner & { calls: string[][] } => {
    const calls: string[][] = []
    return {
      calls,
      sync: (file, args) => void calls.push(['sync', file, ...args]),
      async: (file, args, done) => {
        calls.push(['async', file, ...args])
        done()
      }
    }
  }

  it('ends the whole tree with taskkill /T /F by pid, then kills the child', () => {
    const r = runner()
    const child = { pid: 4242, kill: vi.fn(() => true) }
    killTree(child, true, r, 'win32')
    expect(r.calls[0][0]).toBe('sync')
    expect(r.calls[0][1]).toMatch(/[\\/]System32[\\/]taskkill\.exe$/i)
    expect(r.calls[0].slice(2)).toEqual(['/PID', '4242', '/T', '/F'])
    expect(child.kill).toHaveBeenCalledTimes(1)
    killTree(child, false, r, 'win32')
    expect(r.calls[1][0]).toBe('async')
    expect(child.kill).toHaveBeenCalledTimes(2)
  })

  it('falls back to child.kill() without a pid or off Windows', () => {
    const r = runner()
    const kill = vi.fn(() => true)
    killTree({ kill }, true, r, 'win32')
    killTree({ pid: 7, kill }, false, r, 'linux')
    expect(r.calls).toEqual([])
    expect(kill).toHaveBeenCalledTimes(2)
  })
})
