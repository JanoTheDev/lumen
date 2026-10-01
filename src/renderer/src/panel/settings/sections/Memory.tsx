import { Card, NumberField, SegmentedControl, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

export function Memory({ cfg, patch }: SectionProps): JSX.Element {
  const m = cfg.memory
  return (
    <>
      <Card
        title="Memory"
        description="Lumen can remember your preferences and how you use your apps. It stays on this PC."
      >
        <Switch
          checked={m.enabled}
          onChange={(enabled) => patch({ memory: { enabled } })}
          label="Remember things about me"
        />
        <SegmentedControl
          label="Learning new things"
          value={m.autoLearn}
          options={[
            { value: 'ask', label: 'Ask me first' },
            { value: 'auto', label: 'Automatically' },
            { value: 'off', label: 'Don’t learn' }
          ]}
          onChange={(autoLearn) => patch({ memory: { autoLearn } })}
        />
        <Switch
          checked={m.privateMode}
          onChange={(privateMode) => patch({ memory: { privateMode } })}
          label="Private mode"
          hint="Lumen uses what it already knows but saves nothing new."
        />
        <NumberField
          label="Forget after"
          value={m.retentionDays}
          min={1}
          max={3650}
          unit="days"
          onCommit={(retentionDays) => patch({ memory: { retentionDays } })}
        />
      </Card>

      <Card title="What Lumen remembers">
        <p className="ui-hint">
          Reviewing, editing, exporting and deleting memories will appear here.
        </p>
      </Card>
    </>
  )
}
