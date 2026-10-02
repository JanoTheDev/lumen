// Paper size for made documents (PDF and Word): Letter where the system's region uses it
// (US, Canada, Mexico, …), else A4.
import { app } from 'electron'

export type PageSize = 'Letter' | 'A4'

/** Regions whose paper size is Letter (CLDR). */
const LETTER_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'PR',
  'CL',
  'CO',
  'CR',
  'DO',
  'GT',
  'PA',
  'SV',
  'VE',
  'BZ'
])

/** Letter for a locale whose region uses it ("en-US", "es-MX"), else A4. Pure. */
export function pageSizeFor(locale: string | undefined): PageSize {
  const region = /[-_]([A-Za-z]{2})(?:$|[-_.@])/.exec(locale ?? '')?.[1]?.toUpperCase()
  return region && LETTER_REGIONS.has(region) ? 'Letter' : 'A4'
}

function systemLocale(): string {
  try {
    return app.getSystemLocale() || app.getLocale()
  } catch {
    return ''
  }
}

/** The page size of the system's region. */
export function systemPageSize(): PageSize {
  return pageSizeFor(systemLocale())
}
