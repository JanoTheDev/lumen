import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import {
  colIndex,
  csvWithStats,
  htmlToText,
  pptxText,
  readPptx,
  readXlsx,
  tableStats,
  xlsxText
} from '../../src/main/files/office'
import { checkDroppedPath } from '../../src/main/files/store'
import { fileText } from '../../src/main/files/content'
import { toDocx } from '../../src/main/docs-out/docx'

// An Excel-made workbook: shared strings with rich text and phonetic runs, a boolean, an
// inline string, a gap in the columns and a second sheet through its relationship.
async function workbook(): Promise<Buffer> {
  const z = new JSZip()
  z.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Costs &amp; more" sheetId="1" r:id="rId1"/><sheet r:id="rId2" name="Two" sheetId="2"/></sheets></workbook>'
  )
  z.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/other.xml"/></Relationships>'
  )
  z.file(
    'xl/sharedStrings.xml',
    '<sst><si><t>Item</t></si><si><r><t>Co</t></r><r><t>st</t></r></si><si><t>Tent</t><rPh><t>ten</t></rPh></si></sst>'
  )
  z.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>99.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Stove &lt;gas&gt;</t></is></c><c r="B3" t="b"><v>1</v></c><c r="C3"><v>12</v></c></row></sheetData></worksheet>'
  )
  z.file(
    'xl/worksheets/other.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>x</v></c></row></sheetData></worksheet>'
  )
  return z.generateAsync({ type: 'nodebuffer' })
}

describe('xlsx reading', () => {
  it('reads sheets in order with shared, inline and boolean cells', async () => {
    const sheets = readXlsx(await workbook())
    expect(sheets.map((s) => s.name)).toEqual(['Costs & more', 'Two'])
    expect(sheets[0].rows).toEqual([
      ['Item', '', 'Cost'],
      ['Tent', '', '99.5'],
      ['Stove <gas>', 'TRUE', '12']
    ])
    expect(sheets[1].rows).toEqual([['x']])
    expect(colIndex('AB12')).toBe(27)
  })

  it('gives the model stats and CSV text per sheet', async () => {
    const text = xlsxText(await workbook())
    expect(text).toContain('## Sheet "Costs & more"')
    expect(text).toContain('Cost (numbers 12–99.5, mean 55.75, sum 111.5)')
    expect(text).toContain('Stove <gas>,TRUE,12')
  })

  it('refuses a zip that is not a workbook', async () => {
    const z = new JSZip()
    z.file('a.txt', 'x')
    expect(() => readXlsx(z.generateSync({ type: 'nodebuffer' }))).toThrow()
  })
})

describe('pptx reading', () => {
  it('reads slide text in slide order', async () => {
    const z = new JSZip()
    z.file('ppt/presentation.xml', '<p:presentation/>')
    const slide = (lines: string[]): string =>
      `<p:sld><p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sld>`
    z.file('ppt/slides/slide10.xml', slide(['Ten']))
    z.file('ppt/slides/slide2.xml', slide(['Two', 'More &amp; more']))
    const buf = await z.generateAsync({ type: 'nodebuffer' })
    expect(readPptx(buf)).toEqual(['Two\nMore & more', 'Ten'])
    expect(pptxText(buf)).toBe('## Slide 1\nTwo\nMore & more\n\n## Slide 2\nTen')
  })
})

describe('tables', () => {
  it('summarizes columns', () => {
    const s = tableStats([
      ['Name', 'Amount'],
      ['a', '1,200'],
      ['b', '300'],
      ['', '']
    ])
    expect(s.rows).toBe(2)
    expect(s.columns[1]).toMatchObject({ name: 'Amount', min: 300, max: 1200, sum: 1500 })
    expect(s.columns[0]).toMatchObject({ distinct: 2 })
    expect(csvWithStats('a;b\n1;2\n')).toMatch(/^\[table: 1 data rows × 2 columns/)
  })

  it('adds the stats line to shared CSV files only', async () => {
    const csv = Buffer.from('a,b\n1,2\n')
    expect(await fileText({ kind: 'text', name: 'x.CSV' }, csv)).toMatch(/^\[table: 1 data rows/)
    expect(await fileText({ kind: 'text', name: 'xcsv.txt' }, csv)).toBe('a,b\n1,2\n')
  })
})

describe('docx text', () => {
  it('keeps headings, lists and tables', async () => {
    const html =
      '<h1>Plan</h1><p>Intro &amp; more</p><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><th>B|C</th></tr><tr><td>1</td><td><p>2</p></td></tr></table><img src="data:x">'
    expect(htmlToText(html)).toBe(
      '# Plan\n\nIntro & more\n\n- One\n\n- Two\n\n| A | B\\|C |\n| --- | --- |\n| 1 | 2 |'
    )
  })

  it('reads a Word file Lumen wrote', async () => {
    const buf = toDocx({
      title: 'T',
      blocks: [
        { kind: 'heading', text: 'Head', level: 1, items: [], rows: [] },
        { kind: 'table', text: '', level: 0, items: [], rows: [['x', 'y']] }
      ]
    })
    const text = await fileText({ kind: 'docx', name: 'a.docx' }, buf)
    expect(text).toContain('# Head')
    expect(text).toContain('| x | y |')
  })
})

describe('shared Office files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-office-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts xlsx and pptx with zip magic, refuses renamed files', async () => {
    const xlsx = join(dir, 'a.xlsx')
    writeFileSync(xlsx, await workbook())
    expect(await checkDroppedPath(xlsx)).toMatchObject({ ok: true, kind: 'sheet' })
    const fake = join(dir, 'b.pptx')
    writeFileSync(fake, 'MZ not a zip')
    expect(await checkDroppedPath(fake)).toMatchObject({ ok: false })
  })
})
