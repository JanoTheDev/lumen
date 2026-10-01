// Pure update policy: which build updates how, the feed for the portable build, version order.
import type { UpdateMode } from '@shared/channels'

export const RELEASES_URL = 'https://github.com/JanoTheDev/lumen/releases'
/** latest.yml of the newest published (non-draft, non-prerelease) release. */
export const LATEST_FEED_URL = `${RELEASES_URL}/latest/download/latest.yml`
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
export const FIRST_CHECK_DELAY_MS = 60 * 1000
export const TICK_MS = 60 * 60 * 1000

export function updateMode(packaged: boolean, portable: boolean): UpdateMode {
  if (!packaged) return 'dev'
  return portable ? 'portable' : 'installer'
}

/** A daily check is due: automatic updates on and the last attempt a day or more ago. */
export function checkDue(enabled: boolean, lastAttempt: number | undefined, now: number): boolean {
  return enabled && (lastAttempt === undefined || now - lastAttempt >= CHECK_EVERY_MS)
}

/** `version:` from an electron-updater latest.yml. */
export function parseFeedVersion(yml: string): string | null {
  const m = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(yml)
  return m ? m[1] : null
}

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

function parse(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  if (!m) return null
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] }
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const na = /^\d+$/.test(a[i])
    const nb = /^\d+$/.test(b[i])
    if (na && nb && +a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1
    if (na !== nb) return na ? -1 : 1
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** SemVer order of a and b (-1, 0, 1); null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  return comparePre(pa.pre, pb.pre)
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1
}

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version.replace(/^v/, '')}`
}
