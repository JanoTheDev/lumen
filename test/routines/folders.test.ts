// The folder of a file automation: only an existing local folder that is not a drive root or
// Lumen's own data (the Settings IPC path goes through the same check as a spoken name).
import { describe, expect, it } from 'vitest'
import { folderAllowed, resolveFolderWith, type FolderPorts } from '../../src/main/routines/folders'

const HOME = 'C:\\Users\\me'
const DATA = [`${HOME}\\.ai-overlay`, `${HOME}\\AppData\\Roaming\\Lumen`]
const DIRS = new Set(
  [`${HOME}\\Invoices`, ...DATA, `${HOME}\\.ai-overlay\\tasks`, HOME, 'C:\\'].map((d) =>
    d.toLowerCase()
  )
)
const ports: FolderPorts = {
  known: (n) => (n === 'downloads' ? `${HOME}\\Downloads` : null),
  isDir: (p) => DIRS.has(p.toLowerCase()),
  real: (p) => p,
  dataDirs: () => DATA
}

describe('resolveFolderWith', () => {
  it('takes known names and existing local folders', () => {
    expect(resolveFolderWith('my downloads folder', ports)).toBe(`${HOME}\\Downloads`)
    expect(resolveFolderWith(`${HOME}\\Invoices`, ports)).toBe(`${HOME}\\Invoices`)
  })

  it('refuses UNC, device, relative, missing, drive roots and Lumen data', () => {
    for (const bad of [
      '\\\\srv\\x',
      '//srv/x',
      `\\\\?\\${HOME}\\Invoices`,
      'Invoices',
      'C:\\nope',
      'C:\\',
      ...DATA,
      `${HOME}\\.ai-overlay\\tasks`,
      // Holds the data folder.
      HOME
    ])
      expect(resolveFolderWith(bad, ports), bad).toBeNull()
  })

  it('a saved folder from a hand-edited file is checked too', () => {
    expect(folderAllowed('\\\\srv\\x', DATA)).toBe(false)
    expect(folderAllowed(DATA[0], DATA)).toBe(false)
    expect(folderAllowed(`${HOME}\\Invoices`, DATA)).toBe(true)
  })
})
