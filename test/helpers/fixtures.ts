import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_CONFIG_V2, configV2Schema, type ConfigV2 } from '../../src/shared/config'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k]
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
        ? merge(cur, v as DeepPartial<typeof cur>)
        : v
  }
  return out as T
}

/** A valid v2 config: the defaults with `over` deep-merged in. Throws if the result is invalid. */
export function makeConfig(over?: DeepPartial<ConfigV2>): ConfigV2 {
  return configV2Schema.parse(merge(structuredClone(DEFAULT_CONFIG_V2), over))
}

/**
 * Base64 of a minimal baseline JPEG header (SOI, APP0, SOF0, EOI) that reports `w`x`h`.
 * Enough for code that reads image dimensions; it does not decode to pixels.
 */
export function tinyJpeg(w = 640, h = 360): string {
  const soi = 'ffd8ffe000104a46494600010100000100010000'
  const sof0 = 'ffc0001108' + [h, w].map((n) => n.toString(16).padStart(4, '0')).join('')
  const rest = '03012200021101031101ffd9'
  return Buffer.from(soi + sof0 + rest, 'hex').toString('base64')
}

/** A fresh temp directory plus its cleanup, for config/guide store tests. */
export function tempDir(prefix = 'lumen-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
