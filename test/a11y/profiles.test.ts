import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG_V2,
  configPatchSchema,
  configV2Schema,
  withV2Defaults,
  type ConfigV2
} from '../../src/shared/config'
import {
  PROFILES,
  PROFILE_IDS,
  describeChanges,
  diffFromProfile,
  mergeProfiles,
  profilePatch,
  profileSummary
} from '../../src/shared/profiles'

const clone = (c: ConfigV2): ConfigV2 => structuredClone(c)

/** Same one-level merge as main's saveConfig. */
function apply(cfg: ConfigV2, patch: unknown): ConfigV2 {
  const parsed = configPatchSchema.parse(patch) as Record<string, unknown>
  const next: Record<string, unknown> = { ...cfg }
  for (const [k, v] of Object.entries(parsed)) {
    const prev = next[k]
    next[k] =
      v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object'
        ? { ...prev, ...v }
        : v
  }
  return configV2Schema.parse(withV2Defaults(next))
}

describe('profiles', () => {
  it.each(PROFILE_IDS)('%s yields a valid config', (id) => {
    const cfg = apply(clone(DEFAULT_CONFIG_V2), profilePatch(DEFAULT_CONFIG_V2, [id]))
    expect(cfg.a11y.profiles).toEqual([id])
    expect(diffFromProfile(cfg)).toEqual([])
    expect(profileSummary(cfg)).toBe(PROFILES[id].name)
  })

  it('all profiles together still validate', () => {
    const cfg = apply(clone(DEFAULT_CONFIG_V2), profilePatch(DEFAULT_CONFIG_V2, [...PROFILE_IDS]))
    expect(diffFromProfile(cfg)).toEqual([])
  })

  it('keeps nested fields the profiles do not touch', () => {
    const base = clone(DEFAULT_CONFIG_V2)
    base.a11y.dwell.pauseCorner = 'bottom-right'
    const cfg = apply(base, profilePatch(base, ['eye-gaze']))
    expect(cfg.a11y.dwell.pauseCorner).toBe('bottom-right')
    expect(cfg.a11y.dwell.radiusPx).toBe(30)
    expect(cfg.a11y.switch).toEqual(base.a11y.switch)
  })

  it('merges to the more accessible value', () => {
    const m = mergeProfiles(['motor-pointer', 'eye-gaze'])
    expect(m['dwellClick.dwellMs']).toBe(1200)
    expect(m['a11y.dwell.radiusPx']).toBe(30)
    expect(m['a11y.dwell.ringSize']).toBe('xl')
    expect(mergeProfiles(['standard', 'cognitive']).answerAutoCloseMs).toBe(0)
    expect(mergeProfiles(['standard', 'cognitive'])['agent.confirm']).toBe('always')
    expect(mergeProfiles(['eye-gaze', 'low-vision'])['a11y.uiScale']).toBe(1.6)
  })

  it('blind + low vision: no buddy, screen reader, high contrast kept', () => {
    const m = mergeProfiles(['low-vision', 'blind'])
    expect(m['buddy.enabled']).toBe(false)
    expect(m['a11y.announce']).toBe('auto')
    expect(m.theme).toBe('high-contrast')
    expect(m['voice.tts']).toBe('off')
    expect(m['a11y.focusNarration']).toBe(false)
  })

  it('deaf + blind: screen reader, no speech', () => {
    const m = mergeProfiles(['deaf-hoh', 'blind'])
    expect(m['voice.tts']).toBe('off')
    expect(m['a11y.announce']).toBe('auto')
  })

  it('ignores unknown ids', () => {
    expect(mergeProfiles(['nope'])).toEqual({})
    expect(profilePatch(DEFAULT_CONFIG_V2, ['nope', 'switch']).a11y?.profiles).toEqual(['switch'])
  })

  it('reports custom once a profile setting changes', () => {
    let cfg = apply(clone(DEFAULT_CONFIG_V2), profilePatch(DEFAULT_CONFIG_V2, ['motor-voice']))
    cfg = apply(cfg, { answerAutoCloseMs: 5000 })
    expect(diffFromProfile(cfg)).toEqual(['answerAutoCloseMs'])
    expect(profileSummary(cfg)).toBe('Custom (based on Motor – voice)')
    expect(profileSummary(DEFAULT_CONFIG_V2)).toBe('')
  })

  it('describes only real changes, in plain words', () => {
    const lines = describeChanges(DEFAULT_CONFIG_V2, ['low-vision'])
    expect(lines).toContain('Interface size 160%')
    expect(lines).toContain('Answers stay until you close them')
    const after = apply(clone(DEFAULT_CONFIG_V2), profilePatch(DEFAULT_CONFIG_V2, ['low-vision']))
    expect(describeChanges(after, ['low-vision'])).toEqual([])
  })
})
