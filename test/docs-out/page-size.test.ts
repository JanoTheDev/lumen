import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { pageSizeFor } from '../../src/main/docs-out/page-size'
import { toDocx } from '../../src/main/docs-out/docx'
import { render } from '../../src/main/docs-out/write'
import { readZip } from '../../src/main/packs/zip-read'
import type { DocContent } from '../../src/main/docs-out/schema'

const DOC: DocContent = {
  title: 'Plan',
  blocks: [{ kind: 'table', level: 0, text: '', items: [], rows: [['a', 'b']] }]
}

function documentXml(buf: Buffer): string {
  return readZip(buf)
    .find((f) => f.name === 'word/document.xml')!
    .data.toString('utf8')
}

describe('page size by region', () => {
  it('is Letter where the region uses it, else A4', () => {
    expect(pageSizeFor('en-US')).toBe('Letter')
    expect(pageSizeFor('es-MX')).toBe('Letter')
    expect(pageSizeFor('fr-CA')).toBe('Letter')
    expect(pageSizeFor('en_US.UTF-8')).toBe('Letter')
    expect(pageSizeFor('en-GB')).toBe('A4')
    expect(pageSizeFor('nl-NL')).toBe('A4')
    expect(pageSizeFor('zh-Hans-CN')).toBe('A4')
    expect(pageSizeFor('en')).toBe('A4')
    expect(pageSizeFor('')).toBe('A4')
    expect(pageSizeFor(undefined)).toBe('A4')
  })

  it('writes a Word file on Letter paper with 1" margins and a matching table width', () => {
    const xml = documentXml(toDocx(DOC, 'Letter'))
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
    expect(xml).toContain('w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"')
    expect(xml).toContain('<w:gridCol w:w="4680"/>')
  })

  it('writes A4 by default and for A4 regions', () => {
    for (const buf of [toDocx(DOC), toDocx(DOC, 'A4')]) {
      const xml = documentXml(buf)
      expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
      expect(xml).toContain('<w:gridCol w:w="4513"/>')
    }
  })

  it('render passes the page size to the Word writer', async () => {
    const buf = (await render('docx', DOC, async () => Buffer.alloc(0), 'Letter')) as Buffer
    expect(documentXml(buf)).toContain('w:w="12240"')
  })
})
