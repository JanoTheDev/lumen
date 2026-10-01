// Pure helpers for the Voice settings section (unit-tested).
import type { SelectOption } from '../../../ui'

export type PausePreset = 'short' | 'normal' | 'long'

/** Simple silence detection: how long a pause ends a recording. */
export const PAUSE_PRESETS: Record<PausePreset, number> = {
  short: 900,
  normal: 1500,
  long: 2500
}

export const PAUSE_OPTIONS: ReadonlyArray<SelectOption<PausePreset>> = [
  { value: 'short', label: 'Short' },
  { value: 'normal', label: 'Normal' },
  { value: 'long', label: 'Long' }
]

/** The preset a silence length matches, or null for a custom value. */
export function pausePresetOf(silenceMs: number): PausePreset | null {
  for (const [id, ms] of Object.entries(PAUSE_PRESETS) as Array<[PausePreset, number]>) {
    if (ms === silenceMs) return id
  }
  return null
}

/** Slider text for the wake sensitivity (0..1). */
export function sensitivityText(s: number): string {
  if (s <= 0.2) return 'Strict'
  if (s < 0.4) return 'Careful'
  if (s <= 0.6) return 'Balanced'
  if (s < 0.8) return 'Eager'
  return 'Very eager'
}

export interface MicDevice {
  deviceId: string
  label: string
  kind: string
}

/**
 * Microphone choices: the system default first, then each input once. Without mic permission
 * Chromium hides labels, so unnamed inputs get a numbered name. A saved device that is not
 * plugged in stays selectable so the setting doesn't silently change.
 */
export function micOptions(devices: readonly MicDevice[], saved: string): SelectOption<string>[] {
  const out: SelectOption<string>[] = [{ value: '', label: 'Windows default' }]
  let n = 0
  for (const d of devices) {
    if (d.kind !== 'audioinput' || !d.deviceId) continue
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue
    n++
    out.push({ value: d.deviceId, label: d.label || `Microphone ${n}` })
  }
  if (saved && !out.some((o) => o.value === saved)) {
    out.push({ value: saved, label: 'Saved microphone (not connected)' })
  }
  return out
}

/** Meter level 0..1 from float samples: RMS on a -60..0 dB scale. */
export function meterLevel(samples: Float32Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / samples.length)
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}
