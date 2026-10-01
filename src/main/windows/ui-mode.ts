// Which window set runs: the assistant bar, per-display screen layer and panel window (v2),
// or the old six windows (v1, only with LUMEN_UI=v1 while they are being removed).
// The config's ui.v2 is no longer read.

let cached: boolean | null = null

export function uiV2(): boolean {
  if (cached !== null) return cached
  cached = process.env.LUMEN_UI !== 'v1'
  return cached
}
