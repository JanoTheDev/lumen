import { beforeEach, describe, expect, it } from 'vitest'
import {
  FILES_HEADER,
  filesFor,
  resetAttachState,
  takeFilesFor,
  toAttachments
} from '../../src/main/files/attach'
import { clearFiles, registerFile, type SharedFile } from '../../src/main/files/store'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const f = (name: string, fresh = false, kind: SharedFile['kind'] = 'pdf'): SharedFile => ({
  id: `f_${name.replace(/\W/g, '').slice(0, 8).toLowerCase()}`,
  name,
  size: 1,
  kind,
  path: `C:\\x\\${name}`,
  fresh
})

describe('filesFor', () => {
  const report = f('Quarterly report.pdf')
  const photo = f('holiday.png', false, 'image')

  it('picks nothing without files or without a reference', () => {
    expect(filesFor('summarize this', [], true)).toEqual([])
    expect(filesFor('open chrome', [f('a.pdf', true)], true)).toEqual([])
    expect(filesFor('what time is it in Tokyo', [report], false)).toEqual([])
    expect(filesFor('summarize this', [report], false)).toEqual([])
  })

  it('a file named by name or stem', () => {
    expect(filesFor('what does quarterly report say about sales', [report, photo], false)).toEqual([
      report
    ])
    expect(filesFor('describe holiday.png', [report, photo], false)).toEqual([photo])
  })

  it('every file for a file word', () => {
    expect(filesFor('summarize the pdf', [report, photo], false)).toEqual([report, photo])
    expect(filesFor('what is in the document', [report], false)).toEqual([report])
  })

  it('a reading request right after a drop takes the fresh files', () => {
    const fresh = f('notes.md', true, 'text')
    expect(filesFor('summarize this', [report, fresh], false)).toEqual([fresh])
    expect(filesFor('what does it say', [fresh], false)).toEqual([fresh])
  })

  it('follow-ups keep the files only after a turn that used them', () => {
    expect(filesFor('and what about the second part of it', [report], true)).toEqual([report])
    expect(filesFor('and what about the second part of it', [report], false)).toEqual([])
  })
})

describe('takeFilesFor', () => {
  beforeEach(() => {
    clearFiles()
    resetAttachState()
  })

  it('a drop is fresh for one request; follow-ups keep it only after use', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lumen-attach-')), 'notes.txt')
    writeFileSync(p, 'hello')
    await registerFile(p)
    expect(takeFilesFor('open chrome')).toEqual([])
    expect(takeFilesFor('summarize this')).toEqual([])
    await registerFile(p)
    expect(takeFilesFor('summarize this').map((x) => x.name)).toEqual(['notes.txt'])
    expect(takeFilesFor('what about the end of it').map((x) => x.name)).toEqual(['notes.txt'])
    expect(takeFilesFor('open chrome')).toEqual([])
    expect(takeFilesFor('click it')).toEqual([])
  })
})

describe('toAttachments', () => {
  it('splits text, images and PDFs', () => {
    const a = toAttachments([
      { type: 'text', text: '<file>a</file>' },
      { type: 'image', base64: 'AAA', mediaType: 'image/png' },
      { type: 'document', name: 'r.pdf', base64: 'BBB', mediaType: 'application/pdf' }
    ])
    expect(a.text).toBe(`${FILES_HEADER}\n<file>a</file>`)
    expect(a.images).toEqual([{ base64: 'AAA', mediaType: 'image/png' }])
    expect(a.documents).toEqual([{ name: 'r.pdf', base64: 'BBB', mediaType: 'application/pdf' }])
    expect(toAttachments([]).text).toBe('')
  })
})
