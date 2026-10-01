import { useEffect, useState } from 'react'
import type { ShortcutStatus } from '@shared/channels'
import { profileSummary } from '@shared/profiles'
import { Button, Card, NumberField, SegmentedControl, Slider, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

// Keys a commercial switch interface usually sends; two keys = step scanning (move, pick).
const SWITCH_KEYS = [
  { value: 'Space', label: 'Space' },
  { value: 'Enter', label: 'Enter' },
  { value: 'F8', label: 'F8' },
  { value: 'Space,Enter', label: 'Space + Enter' }
] as const

const SCAN_MODES = [
  { value: 'auto', label: 'Moves by itself' },
  { value: 'step', label: 'I move it' }
] as const

const SHORTCUT_STATE: Record<ShortcutStatus['state'], string> = {
  bound: 'On',
  off: 'Off',
  inactive: 'Only when needed',
  conflict: 'Clash',
  taken: 'Used by another app'
}

function useShortcuts(cfg: SectionProps['cfg']): ShortcutStatus[] {
  const [list, setList] = useState<ShortcutStatus[]>([])
  useEffect(() => {
    window.lumen
      .invoke('a11y:shortcuts')
      .then(setList)
      .catch(() => {})
  }, [cfg])
  return list
}

const TRISTATE = [
  { value: 'system', label: 'Match Windows' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
] as const

export function Accessibility({ cfg, patch }: SectionProps): JSX.Element {
  const summary = profileSummary(cfg)
  const sw = cfg.a11y.switch
  const switchKeys = sw.keys.join(',')
  const keyChoice = SWITCH_KEYS.some((k) => k.value === switchKeys) ? switchKeys : 'Space'
  const shortcuts = useShortcuts(cfg)
  return (
    <>
      <Card
        title="Profile"
        description="Ready-made settings for how you use your PC. Pick several if they fit."
      >
        <p>{summary || 'Standard settings, no profile picked.'}</p>
        <div className="panel-row">
          <Button onClick={() => window.lumen.send('panel:open', 'onboarding')}>
            Choose profiles
          </Button>
        </div>
      </Card>

      <Card title="Seeing" description="Size, motion and contrast for every Lumen window.">
        <Slider
          label="Interface size"
          value={cfg.a11y.uiScale}
          min={0.75}
          max={2}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(uiScale) => patch({ a11y: { uiScale } })}
          hint="Scales text and controls. Overlays above 160% are capped for now."
        />
        <SegmentedControl
          label="Reduce motion"
          value={cfg.a11y.reduceMotion}
          options={TRISTATE}
          onChange={(reduceMotion) => patch({ a11y: { reduceMotion } })}
        />
        <SegmentedControl
          label="High contrast"
          value={cfg.a11y.contrast}
          options={TRISTATE}
          onChange={(contrast) => patch({ a11y: { contrast } })}
        />
      </Card>

      <Card
        title="Understanding"
        description="Help when learning or when you want to stay in control."
      >
        <Switch
          checked={cfg.explainBeforeDo}
          onChange={(explainBeforeDo) => patch({ explainBeforeDo })}
          label="Explain before doing"
          hint="Show what Lumen is about to do for a moment before it acts."
        />
        <Switch
          checked={cfg.showConfidence}
          onChange={(showConfidence) => patch({ showConfidence })}
          label="Say when Lumen isn’t sure"
          hint="Gives you time to say “stop”."
        />
      </Card>

      <Card title="Timings" description="How long things stay on screen.">
        <NumberField
          label="Answer card"
          value={cfg.answerAutoCloseMs}
          min={2000}
          max={120000}
          step={1000}
          unit="ms"
          onCommit={(answerAutoCloseMs) => patch({ answerAutoCloseMs })}
        />
        <NumberField
          label="Listening pill"
          value={cfg.hudAutoCloseMs}
          min={1000}
          max={30000}
          step={500}
          unit="ms"
          onCommit={(hudAutoCloseMs) => patch({ hudAutoCloseMs })}
        />
      </Card>

      <Card
        title="Dwell click"
        description="Click by holding the pointer still. For people who can move a pointer but find clicking hard."
      >
        <Switch
          checked={cfg.dwellClick.enabled}
          onChange={(enabled) => patch({ dwellClick: { enabled } })}
          label="Click when the pointer rests"
        />
        <NumberField
          label="Rest time"
          value={cfg.dwellClick.dwellMs}
          min={500}
          max={3000}
          step={100}
          unit="ms"
          hint="Shorter is faster but clicks by accident more often."
          onCommit={(dwellMs) => patch({ dwellClick: { dwellMs } })}
        />
        <NumberField
          label="Pause after a click"
          value={cfg.dwellClick.cooldownMs}
          min={500}
          max={5000}
          step={250}
          unit="ms"
          onCommit={(cooldownMs) => patch({ dwellClick: { cooldownMs } })}
        />
      </Card>

      <Card
        title="Switch scanning"
        description="Lumen moves through choices and you press your switch to pick one. Your switch key stops typing in other apps while this is on."
      >
        <Switch
          checked={sw.enabled}
          onChange={(enabled) => patch({ a11y: { switch: { ...sw, enabled } } })}
          label="Use a switch"
          hint="Say “start scanning” or “stop scanning” to turn it on and off for now."
        />
        <SegmentedControl
          label="Switch keys"
          value={keyChoice}
          options={SWITCH_KEYS}
          onChange={(v) => {
            const keys = v.split(',')
            patch({
              a11y: { switch: { ...sw, keys, mode: keys.length > 1 ? 'step' : 'auto' } }
            })
          }}
        />
        {sw.keys.length > 1 && (
          <SegmentedControl
            label="Highlight"
            value={sw.mode}
            options={SCAN_MODES}
            onChange={(mode) => patch({ a11y: { switch: { ...sw, mode } } })}
          />
        )}
        <NumberField
          label="Scan speed"
          value={sw.scanIntervalMs}
          min={300}
          max={10000}
          step={100}
          unit="ms"
          hint="How long each choice stays highlighted."
          onCommit={(scanIntervalMs) => patch({ a11y: { switch: { ...sw, scanIntervalMs } } })}
        />
      </Card>

      <Card
        title="Keyboard shortcuts"
        description="Work anywhere in Windows. Answer keys only act while an answer shows."
      >
        <table className="panel-table">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Keys</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {shortcuts.map((s) => (
              <tr key={s.action}>
                <td>{s.label}</td>
                <td>{s.accelerator ? <kbd>{s.accelerator}</kbd> : 'None'}</td>
                <td>
                  {SHORTCUT_STATE[s.state]}
                  {s.with ? ` with ${s.with}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}
