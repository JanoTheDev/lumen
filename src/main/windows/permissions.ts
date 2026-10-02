import type { Session } from 'electron'
import { isOwnRendererUrl, type RendererEntry } from './factory'

type MediaKind = 'audio' | 'video'

/** Which renderer entry may use which capture device. Everything else is denied. */
const MEDIA_ALLOWED: Partial<Record<RendererEntry, readonly MediaKind[]>> = {
  assistant: ['audio'],
  panel: ['audio', 'video'], // mic test, camera picker labels
  face: ['video']
}

/**
 * Display capture (07 T30 lesson recording): only the hidden recorder window, and only while a
 * recording is starting or running. Never audio.
 */
let displayCapture = false

export function setDisplayCaptureActive(on: boolean): void {
  displayCapture = on
}

/** The renderer entry a URL belongs to (`.../<entry>.html`), or null for anything foreign. */
export function rendererEntryOf(url: string): RendererEntry | null {
  if (!url || !isOwnRendererUrl(url)) return null
  try {
    const m = /\/([a-z0-9]+)\.html$/i.exec(new URL(url).pathname)
    return m ? (m[1].toLowerCase() as RendererEntry) : null
  } catch {
    return null
  }
}

/** Pure decision: may `url` get `permission` (with these media types)? */
export function allowPermission(
  permission: string,
  url: string,
  mediaTypes: readonly string[] = [],
  capturing = displayCapture
): boolean {
  if (permission !== 'media') return false
  const entry = rendererEntryOf(url)
  if (!entry) return false
  // A desktop source request names no device type (or only video).
  if (entry === 'recorder') return capturing && mediaTypes.every((t) => t === 'video')
  const allowed = MEDIA_ALLOWED[entry] ?? []
  if (mediaTypes.length === 0) return allowed.length > 0
  return mediaTypes.every((t) => (allowed as readonly string[]).includes(t))
}

/** Denies every permission except mic, camera and the recorder's screen where they are needed. */
export function installPermissionHandlers(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = ('requestingUrl' in details && details.requestingUrl) || wc?.getURL() || ''
    const media = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    callback(allowPermission(permission, url, media))
  })
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    const url = details?.requestingUrl || wc?.getURL() || origin
    const media = details?.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : []
    return allowPermission(permission, url, media)
  })
}
