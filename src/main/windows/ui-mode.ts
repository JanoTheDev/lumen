// Which window set runs: the old six windows (v1) or the assistant bar, per-display screen
// layer and panel window (v2). Read once at startup; switching needs a restart.
// LUMEN_UI=v1|v2 overrides the config for testing.
import { loadConfig } from '../config'

let cached: boolean | null = null

export function uiV2(): boolean {
  if (cached !== null) return cached
  const env = process.env.LUMEN_UI
  cached = env === 'v2' ? true : env === 'v1' ? false : loadConfig().ui.v2
  return cached
}
