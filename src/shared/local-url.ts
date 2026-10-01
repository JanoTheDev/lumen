// Where a "local" model server lives. Local only trusts a server on this PC (loopback); a server
// elsewhere on the home network counts only with models.localLan on.

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/** The URL points at this PC: localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackUrl(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  return ipv4(host)?.[0] === 127
}

/**
 * The URL points at this PC or a private network address: 10/8, 172.16/12, 192.168/16,
 * 169.254/16, IPv6 unique-local / link-local, or a single-label / .local / .lan / .home.arpa
 * name.
 */
export function isLanUrl(url: string): boolean {
  if (isLoopbackUrl(url)) return true
  const host = hostOf(url)
  if (!host) return false
  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (host.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  return !host.includes('.') || /\.(local|lan|home\.arpa)$/.test(host)
}

/** Local only may use a server at this URL. */
export function localUrlAllowed(url: string, lan: boolean): boolean {
  return isLoopbackUrl(url) || (lan && isLanUrl(url))
}
