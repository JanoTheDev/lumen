import { Card, NumberField, SegmentedControl, Slider, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

const TRISTATE = [
  { value: 'system', label: 'Match Windows' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
] as const

export function Accessibility({ cfg, patch }: SectionProps): JSX.Element {
  return (
    <>
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
    </>
  )
}
