import { describe, expect, it } from 'vitest'
import {
  idFromName,
  parseArgs,
  parseEnv
} from '../../src/renderer/src/panel/settings/sections/connectors-form'
import { SERVER_ID_RE } from '../../src/main/connectors/store'

describe('add connector form', () => {
  it('derives a valid, unique id from the name', () => {
    expect(idFromName('My Files!', [])).toBe('my-files')
    expect(idFromName('My Files', ['my-files'])).toBe('my-files-2')
    expect(idFromName('???', [])).toBe('')
    const long = idFromName('A very long connector name indeed', [])
    expect(long).toMatch(SERVER_ID_RE)
    expect(idFromName('A very long connector name indeed', [long])).toMatch(SERVER_ID_RE)
  })

  it('takes one argument per line', () => {
    expect(parseArgs('-y\n @scope/server \n\nC:/My Docs\r\n')).toEqual([
      '-y',
      '@scope/server',
      'C:/My Docs'
    ])
  })

  it('parses NAME=value lines and never echoes a value in the error', () => {
    expect(parseEnv('TOKEN=a=b\n\nHOME_DIR = x')).toEqual({ env: { TOKEN: 'a=b', HOME_DIR: ' x' } })
    const bad = parseEnv('bad name=secret-value')
    expect(bad.error).toBeTruthy()
    expect(bad.error).not.toContain('secret')
  })
})
