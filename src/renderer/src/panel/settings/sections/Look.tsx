import { ratio } from '../../../theme/contrast'
import {
  ACCENT_PRESETS,
  THEME_V1_TO_V2,
  buildPalette,
  type AccentPreset
} from '../../../theme/themes'
import { Button, Card, SegmentedControl, Switch, TextField, icons } from '../../../ui'
import type { SectionProps } from '../meta'

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast', label: 'High contrast' },
  { value: 'custom', label: 'Custom' }
] as const

type ThemeValue = (typeof THEMES)[number]['value']
const ACCENT_IDS = Object.keys(ACCENT_PRESETS) as AccentPreset[]

const DEFAULT_CUSTOM = { accent: '#2F6FEB', background: '#111318', foreground: '#ECEEF2' }
const HEX = /^#[0-9a-f]{6}$/i

function ColorField({
  label,
  value,
  onCommit
}: {
  label: string
  value: string
  onCommit: (v: string) => void
}): JSX.Element {
  return (
    <div className="panel-color">
      <input
        type="color"
        aria-label={`${label} picker`}
        value={HEX.test(value) ? value : '#000000'}
        onChange={(e) => onCommit(e.target.value.toUpperCase())}
      />
      <TextField label={label} value={value} onCommit={onCommit} accept={(v) => HEX.test(v)} mono />
    </div>
  )
}

function Preview(): JSX.Element {
  return (
    <div className="panel-preview surface" aria-label="Preview" role="img">
      <p className="panel-preview__title">The Compose button is at the top left.</p>
      <p className="ui-hint">Sonnet · just now</p>
      <div className="panel-row">
        <span className="ui-btn ui-btn--primary ui-btn--md">Do it</span>
        <span className="ui-btn ui-btn--secondary ui-btn--md">Stop</span>
      </div>
    </div>
  )
}

export function Look({ cfg, patch }: SectionProps): JSX.Element {
  const legacy = THEME_V1_TO_V2[cfg.theme]
  const theme: ThemeValue = legacy ? legacy.theme : (cfg.theme as ThemeValue)
  const accent = cfg.accent ?? legacy?.accent ?? 'blue'
  const custom = { ...DEFAULT_CUSTOM, ...cfg.themeCustom }
  const built = buildPalette('custom', undefined, custom)
  const fgRatio = ratio(built.palette.fg, built.palette.surface)
  const accentRatio = ratio(built.palette.accent, built.palette.surface)

  const setCustom = (part: Partial<typeof DEFAULT_CUSTOM>): void => {
    patch({ theme: 'custom', themeCustom: { ...custom, ...part } })
  }

  return (
    <>
      <Card title="Theme" description="Applies to every Lumen window.">
        <SegmentedControl
          label="Theme"
          value={theme}
          options={THEMES}
          onChange={(t) =>
            patch(t === 'custom' ? { theme: 'custom', themeCustom: custom } : { theme: t })
          }
        />
        {theme !== 'high-contrast' && theme !== 'custom' && (
          <SegmentedControl
            label="Accent colour"
            value={accent as string}
            options={ACCENT_IDS.map((id) => ({
              value: id,
              label: ACCENT_PRESETS[id].label,
              swatch: ACCENT_PRESETS[id].hex
            }))}
            onChange={(a) => patch({ accent: a as AccentPreset })}
          />
        )}
        <Preview />
      </Card>

      {theme === 'custom' && (
        <Card
          title="Custom colours"
          description="Lumen adjusts colours that would be hard to read."
          actions={
            <Button variant="quiet" icon={icons.repeat} onClick={() => setCustom(DEFAULT_CUSTOM)}>
              Reset
            </Button>
          }
        >
          <ColorField
            label="Accent"
            value={custom.accent}
            onCommit={(v) => setCustom({ accent: v })}
          />
          <ColorField
            label="Background"
            value={custom.background}
            onCommit={(v) => setCustom({ background: v })}
          />
          <ColorField
            label="Text"
            value={custom.foreground}
            onCommit={(v) => setCustom({ foreground: v })}
          />
          <p className="ui-hint tabular" role="status">
            Text contrast {fgRatio.toFixed(1)}:1 · accent contrast {accentRatio.toFixed(1)}:1
            {built.adjusted && ' · Fixed for readability'}
          </p>
        </Card>
      )}

      <Card
        title="Cursor buddy"
        description="A small pointer that flies to what Lumen is showing you."
      >
        <Switch
          checked={cfg.buddy.enabled}
          onChange={(enabled) => patch({ buddy: { enabled } })}
          label="Show the buddy"
        />
        <SegmentedControl
          label="Size"
          value={cfg.buddy.size}
          options={[
            { value: 's', label: 'Small' },
            { value: 'm', label: 'Medium' },
            { value: 'l', label: 'Large' }
          ]}
          onChange={(size) => patch({ buddy: { size } })}
        />
        <Switch
          checked={cfg.buddy.followCursor}
          onChange={(followCursor) => patch({ buddy: { followCursor } })}
          label="Follow my pointer"
        />
      </Card>
    </>
  )
}
