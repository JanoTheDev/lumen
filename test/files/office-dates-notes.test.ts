import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  dateStyles,
  excelDate,
  formatKind,
  pptxText,
  readPptx,
  readXlsx
} from '../../src/main/files/office'

const STYLES =
  '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="0.00&quot; days&quot;"/></numFmts>' +
  '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
  '<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="20"/><xf numFmtId="22"/><xf numFmtId="165"/></cellXfs></styleSheet>'

async function datedBook(date1904 = false): Promise<Buffer> {
  const z = new JSZip()
  z.file(
    'xl/workbook.xml',
    `<workbook xmlns:r="r">${date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`
  )
  z.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
  )
  z.file('xl/styles.xml', STYLES)
  z.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1">' +
      '<c r="A1" s="1"><v>46295</v></c>' +
      '<c r="B1" s="2"><v>45000</v></c>' +
      '<c r="C1" s="3"><v>0.5</v></c>' +
      '<c r="D1" s="4"><v>46295.75</v></c>' +
      '<c r="E1" s="5"><v>3</v></c>' +
      '<c r="F1"><v>46295</v></c>' +
      '<c r="G1" s="1" t="str"><v>46295</v></c>' +
      '</row></sheetData></worksheet>'
  )
  return z.generateAsync({ type: 'nodebuffer' })
}

describe('Excel dates (known gap)', () => {
  it('cells with a date or time format read as ISO dates and times', async () => {
    const [sheet] = readXlsx(await datedBook())
    expect(sheet.rows[0]).toEqual([
      '2026-09-30',
      '2023-03-15',
      '12:00:00',
      '2026-09-30T18:00:00',
      '3',
      '46295',
      '46295'
    ])
  })

  it('the 1904 date system starts on 1 January 1904', async () => {
    const [sheet] = readXlsx(await datedBook(true))
    expect(sheet.rows[0][0]).toBe('2030-10-01')
    expect(excelDate(0, 'date', true)).toBe('1904-01-01')
  })

  it('handles the 1900 leap-year bug and number formats', () => {
    expect(excelDate(1, 'date')).toBe('1900-01-01')
    expect(excelDate(59, 'date')).toBe('1900-02-28')
    expect(excelDate(60, 'date')).toBe('1900-02-29')
    expect(excelDate(61, 'date')).toBe('1900-03-01')
    expect(excelDate(1.25, 'time')).toBe('30:00:00')
    expect(excelDate(-1, 'date')).toBeNull()
    expect(formatKind('[$-409]dddd, mmmm dd, yyyy')).toBe('date')
    expect(formatKind('h:mm AM/PM')).toBe('time')
    expect(formatKind('[h]:mm:ss')).toBe('time')
    expect(formatKind('mm:ss')).toBe('time')
    expect(formatKind('General')).toBeUndefined()
    expect(formatKind('#,##0.00 [$€-407];[Red]-#,##0.00')).toBeUndefined()
    expect(formatKind('0.00 "days"')).toBeUndefined()
    expect([...dateStyles(STYLES)]).toEqual([
      [1, 'date'],
      [2, 'date'],
      [3, 'time'],
      [4, 'datetime']
    ])
  })
})

describe('PowerPoint speaker notes (known gap)', () => {
  it('adds each slide notes after "Notes:"', async () => {
    const z = new JSZip()
    z.file('ppt/presentation.xml', '<p:presentation/>')
    const para = (t: string): string => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`
    z.file('ppt/slides/slide1.xml', `<p:sld><p:txBody>${para('Welcome')}</p:txBody></p:sld>`)
    z.file('ppt/slides/slide2.xml', `<p:sld><p:txBody>${para('Plan')}</p:txBody></p:sld>`)
    z.file(
      'ppt/slides/_rels/slide1.xml.rels',
      '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide7.xml"/></Relationships>'
    )
    z.file(
      'ppt/notesSlides/notesSlide7.xml',
      '<p:notes><p:cSld><p:spTree>' +
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>' +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${para('Say hello')}${para('Then the agenda')}</p:txBody></p:sp>` +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody>${para('1')}</p:txBody></p:sp>` +
        '</p:spTree></p:cSld></p:notes>'
    )
    const buf = await z.generateAsync({ type: 'nodebuffer' })
    expect(readPptx(buf)).toEqual(['Welcome\nNotes: Say hello\nThen the agenda', 'Plan'])
    expect(pptxText(buf)).toContain('## Slide 1\nWelcome\nNotes: Say hello')
  })
})
