import { describe, expect, it } from 'vitest'
import { makeIntent, openIntent, placeOf, targetFormat } from '../../src/main/docs-out/intent'

describe('targetFormat', () => {
  it('is the format asked for, not the source', () => {
    expect(targetFormat('make a word doc with my packing list')).toBe('docx')
    expect(targetFormat('convert this csv to Excel')).toBe('xlsx')
    expect(targetFormat('summarize this PDF into a one-page Word doc')).toBe('docx')
    expect(targetFormat('export the table as csv')).toBe('csv')
    expect(targetFormat('save it as markdown')).toBe('md')
    expect(targetFormat('turn this into a PDF')).toBe('pdf')
    expect(targetFormat('write a csv parser in python')).toBeNull()
    expect(targetFormat('summarize this pdf')).toBeNull()
    expect(targetFormat('in a word, what is it')).toBeNull()
  })
})

describe('makeIntent', () => {
  it('takes requests to make a file', () => {
    expect(makeIntent('make a Word doc with a packing list for a beach trip', false)).toMatchObject(
      {
        format: 'docx',
        place: null,
        convertOnly: false
      }
    )
    expect(
      makeIntent('create a spreadsheet of my monthly costs on my desktop', false)
    ).toMatchObject({ format: 'xlsx', place: 'desktop' })
  })

  it('knows a plain CSV ↔ Excel conversion', () => {
    expect(makeIntent('convert this csv to Excel', true)).toMatchObject({
      format: 'xlsx',
      convertOnly: true,
      reformat: true
    })
    expect(makeIntent('convert this csv to Excel and sort it by date', true)?.convertOnly).toBe(
      false
    )
  })

  it('takes reformatting only when there is a file to reformat', () => {
    expect(makeIntent('turn this into a table', true)).toMatchObject({
      format: null,
      reformat: true
    })
    expect(makeIntent('turn this into a table', false)).toBeNull()
    expect(makeIntent('clean up this document', false)).toMatchObject({ reformat: true })
  })

  it('leaves questions and reading requests to the answer path', () => {
    expect(makeIntent('summarize this pdf', true)).toBeNull()
    expect(makeIntent('what is in this excel file?', true)).toBeNull()
    expect(makeIntent('how do I make a pivot table in excel?', false)).toBeNull()
  })

  it('reads where to put it and whether to replace the original', () => {
    expect(placeOf('save it next to the original')).toBe('next_to_source')
    expect(placeOf('put it in my downloads')).toBe('downloads')
    expect(placeOf('put it in documents')).toBe('documents')
    expect(makeIntent('clean up this document and replace the original', true)?.replace).toBe(true)
  })
})

describe('openIntent', () => {
  it('opens or reveals the made file', () => {
    expect(openIntent('open it')).toBe('open')
    expect(openIntent('Open the file.')).toBe('open')
    expect(openIntent('show it in Explorer')).toBe('reveal')
    expect(openIntent('show me in file explorer')).toBe('reveal')
    expect(openIntent('where did you save it')).toBe('reveal')
    expect(openIntent('open it in Word and print it')).toBeNull()
    expect(openIntent('open that')).toBeNull()
  })
})
