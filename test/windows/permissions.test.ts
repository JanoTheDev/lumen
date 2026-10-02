import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import {
  allowPermission,
  rendererEntryOf,
  setDisplayCaptureActive
} from '../../src/main/windows/permissions'

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

  it('gives screen capture to the recorder window only while a recording is active', () => {
    expect(allowPermission('media', own('recorder'), [], false)).toBe(false)
    expect(allowPermission('media', own('recorder'), ['video'], false)).toBe(false)
    expect(allowPermission('media', own('recorder'), [], true)).toBe(true)
    expect(allowPermission('media', own('recorder'), ['video'], true)).toBe(true)
    expect(allowPermission('media', own('recorder'), ['audio'], true)).toBe(false)
    expect(allowPermission('media', own('recorder'), ['audio', 'video'], true)).toBe(false)
    expect(allowPermission('media', own('panel'), [], true)).toBe(true)
    expect(allowPermission('media', own('screen'), ['video'], true)).toBe(false)
    expect(allowPermission('media', 'https://example.com/recorder.html', [], true)).toBe(false)
    expect(allowPermission('notifications', own('recorder'), [], true)).toBe(false)
    // The module flag: off until a recording turns it on.
    expect(allowPermission('media', own('recorder'))).toBe(false)
    setDisplayCaptureActive(true)
    expect(allowPermission('media', own('recorder'))).toBe(true)
    setDisplayCaptureActive(false)
    expect(allowPermission('media', own('recorder'))).toBe(false)
  })

  it('denies other permissions and foreign origins', () => {
    expect(allowPermission('notifications', own('assistant'))).toBe(false)
    expect(allowPermission('geolocation', own('panel'))).toBe(false)
    expect(allowPermission('media', 'https://example.com/assistant.html', ['audio'])).toBe(false)
  })
})
