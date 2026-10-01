import { describe, expect, it } from 'vitest'
import {
  PAUSE_PRESETS,
  meterLevel,
  micOptions,
  pausePresetOf,
  sensitivityText
} from '../src/renderer/src/panel/settings/sections/voice-options'
import { DEFAULT_CONFIG_V2, WAKE_SENSITIVITY_DEFAULT } from '../src/shared/config'

describe('voice settings helpers', () => {
  it('maps silence lengths to pause presets', () => {
    expect(pausePresetOf(PAUSE_PRESETS.short)).toBe('short')
    expect(pausePresetOf(DEFAULT_CONFIG_V2.vad.silenceMs)).toBe('normal')
    expect(pausePresetOf(PAUSE_PRESETS.long)).toBe('long')
    expect(pausePresetOf(1700)).toBeNull()
  })

  it('names sensitivity steps, default is Balanced', () => {
    expect(sensitivityText(WAKE_SENSITIVITY_DEFAULT)).toBe('Balanced')
    expect(sensitivityText(0)).toBe('Strict')
    expect(sensitivityText(0.3)).toBe('Careful')
    expect(sensitivityText(0.7)).toBe('Eager')
    expect(sensitivityText(1)).toBe('Very eager')
  })

  it('lists microphones: default first, inputs once, unnamed numbered, missing saved kept', () => {
    const devices = [
      { deviceId: 'default', label: 'Default - Headset', kind: 'audioinput' },
      { deviceId: 'communications', label: 'Communications', kind: 'audioinput' },
      { deviceId: 'a', label: 'Headset', kind: 'audioinput' },
      { deviceId: 'b', label: '', kind: 'audioinput' },
      { deviceId: 'c', label: 'Speakers', kind: 'audiooutput' },
      { deviceId: '', label: '', kind: 'audioinput' }
    ]
    expect(micOptions(devices, '')).toEqual([
      { value: '', label: 'Windows default' },
      { value: 'a', label: 'Headset' },
      { value: 'b', label: 'Microphone 2' }
    ])
    expect(micOptions(devices, 'gone').at(-1)).toEqual({
      value: 'gone',
      label: 'Saved microphone (not connected)'
    })
    expect(micOptions(devices, 'a')).toHaveLength(3)
  })

  it('meters silence at 0, full scale at 1, -30 dB at half', () => {
    expect(meterLevel(new Float32Array(0))).toBe(0)
    expect(meterLevel(new Float32Array(256))).toBe(0)
    expect(meterLevel(new Float32Array(256).fill(1))).toBe(1)
    expect(meterLevel(new Float32Array(256).fill(10 ** (-30 / 20)))).toBeCloseTo(0.5, 5)
  })
})
