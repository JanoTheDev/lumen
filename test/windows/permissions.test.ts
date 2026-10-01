import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { allowPermission, rendererEntryOf } from '../../src/main/windows/permissions'

const own = (entry: string): string =>
  pathToFileURL(resolve(__dirname, '../../src/main/renderer', `${entry}.html`)).href

describe('renderer permissions', () => {
  it('maps own renderer urls to their entry', () => {
    expect(rendererEntryOf(own('face'))).toBe('face')
    expect(rendererEntryOf(`${own('panel')}#/settings`)).toBe('panel')
    expect(rendererEntryOf('https://example.com/face.html')).toBeNull()
    expect(rendererEntryOf('')).toBeNull()
  })

  it('gives the mic to the assistant bar and the camera to the face window only', () => {
    expect(allowPermission('media', own('assistant'), ['audio'])).toBe(true)
    expect(allowPermission('media', own('assistant'), ['video'])).toBe(false)
    expect(allowPermission('media', own('face'), ['video'])).toBe(true)
    expect(allowPermission('media', own('face'), ['audio'])).toBe(false)
    expect(allowPermission('media', own('screen'), ['audio'])).toBe(false)
    expect(allowPermission('media', own('a11y'), [])).toBe(false)
  })

  it('denies other permissions and foreign origins', () => {
    expect(allowPermission('notifications', own('assistant'))).toBe(false)
    expect(allowPermission('geolocation', own('panel'))).toBe(false)
    expect(allowPermission('media', 'https://example.com/assistant.html', ['audio'])).toBe(false)
  })
})
