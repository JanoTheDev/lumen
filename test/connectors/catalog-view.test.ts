// Settings → Connectors catalog helpers, and the bar's reply-style chip setting.
import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG } from '@shared/connector-catalog'
import type { ConnectorView } from '@shared/connectors'
import {
  authLine,
  catalogCommandLine,
  catalogGroups,
  catalogInput,
  defaultMethod,
  isAdded
} from '../../src/renderer/src/panel/settings/sections/connectors-catalog-view'
import { barSettings } from '../../src/renderer/src/assistant/useBarSettings'

const entry = (id: string): (typeof CONNECTOR_CATALOG)[number] =>
  CONNECTOR_CATALOG.find((e) => e.id === id)!

const view = (v: Partial<ConnectorView>): ConnectorView => ({
  id: 'x',
  name: 'X',
  transport: 'http',
  enabled: true,
  toolPolicy: {},
  hasBearer: false,
  state: 'idle',
  ...v
})

describe('catalog view', () => {
  it('groups by category and searches all words', () => {
    const all = catalogGroups('')
    expect(all.reduce((n, [, l]) => n + l.length, 0)).toBe(CONNECTOR_CATALOG.length)
    expect(catalogGroups('notion pages').flatMap(([, l]) => l.map((e) => e.id))).toEqual(['notion'])
    expect(catalogGroups('zzz')).toEqual([])
  })

  it('knows what is added already', () => {
    expect(isAdded(entry('notion'), [view({ url: 'https://mcp.notion.com/mcp' })])).toBe(true)
    expect(
      isAdded(entry('files'), [
        view({
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Notes']
        })
      ])
    ).toBe(true)
    expect(
      isAdded(entry('files'), [view({ transport: 'stdio', command: 'npx', args: ['-y', 'other'] })])
    ).toBe(false)
  })

  it('builds the add request per sign-in method', () => {
    expect(defaultMethod(entry('notion'))).toBe('oauth')
    expect(defaultMethod(entry('github'))).toBe('token')
    expect(defaultMethod(entry('context7'))).toBe('none')
    expect(authLine(entry('linear'))).toMatch(/Sign in, or an access token/)
    const choice = { method: 'oauth' as const, token: '', folders: '' }
    expect(catalogInput(entry('notion'), choice, [], false)).toEqual({
      input: {
        id: 'notion',
        name: 'Notion',
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth'
      }
    })
    expect(catalogInput(entry('github'), { ...choice, method: 'token' }, [], false)).toEqual({
      error: 'Paste the access token.'
    })
    const tok = catalogInput(
      entry('github'),
      { method: 'token', token: ' t ', folders: '' },
      ['github'],
      false
    )
    expect(tok).toMatchObject({ input: { id: 'github-2', bearer: 't' } })
  })

  it('local entries need folders where asked, and the trust tick', () => {
    const files = entry('files')
    const c = { method: 'none' as const, token: '', folders: '' }
    expect(catalogInput(files, c, [], true)).toMatchObject({
      error: expect.stringMatching(/Folders/)
    })
    const withDir = { ...c, folders: 'C:\\My Notes\n' }
    expect(catalogInput(files, withDir, [], false)).toMatchObject({
      error: expect.stringMatching(/trust/)
    })
    expect(catalogInput(files, withDir, [], true)).toMatchObject({
      input: {
        transport: 'stdio',
        command: 'npx',
        trustCommand: true,
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Notes']
      }
    })
    expect(catalogCommandLine(files, withDir.folders)).toBe(
      'npx -y @modelcontextprotocol/server-filesystem "C:\\My Notes"'
    )
  })
})

describe('bar style chip', () => {
  it('reads the active reply style from config', () => {
    expect(
      barSettings({ ai: { router: 'llm', style: { name: 'brief', level: 'ultra' } } }).style
    ).toEqual({
      name: 'brief',
      level: 'ultra'
    })
    expect(barSettings({ ai: { router: 'llm' } }).style).toBeNull()
    expect(barSettings(null).style).toBeNull()
  })
})
