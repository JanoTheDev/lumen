// Settings → Voice: dictation feedback and hands-free (04 T47/T48): sounds, the pill next to
// the caret, media ducking, spoken Enter, the hands-free pause and mouse push-to-talk.
import type { ConfigV2 } from '@shared/config'
import { Card, NumberField, Select, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

type MouseButton = ConfigV2['dictation']['mouseButton']

const MOUSE_OPTIONS: { value: MouseButton; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'middle', label: 'Middle button (wheel click)' },
  { value: 'x1', label: 'Back side button' },
  { value: 'x2', label: 'Forward side button' }
]

export function DictationFeedback({ cfg, patch }: SectionProps): JSX.Element {
  const d = cfg.dictation
  const quiet = cfg.agent.background.quiet
  return (
    <Card
      title="Dictation feedback"
      description="What you see and hear while dictating, and other ways to start and finish."
    >
      <Switch
        checked={d.sounds}
        onChange={(sounds) => patch({ dictation: { sounds } })}
        label="Start and stop sounds"
        hint={
          quiet
            ? 'Quiet mode is on, so no sounds play.'
            : 'A short blip when the microphone opens and closes. Quiet mode turns them off.'
        }
      />
      <Switch
        checked={d.caretPill}
        onChange={(caretPill) => patch({ dictation: { caretPill } })}
        label="Show the dictation pill next to the text cursor"
        hint="Some apps don’t report their text cursor; then the pill shows at the bottom."
      />
      <Switch
        checked={d.duckMedia}
        onChange={(duckMedia) => patch({ dictation: { duckMedia } })}
        label="Turn other sound down while dictating"
        hint="Lowers the volume while you speak and puts it back when you stop. If you change the volume meanwhile, Lumen leaves it alone."
      />
      <Switch
        checked={d.spokenKeys}
        onChange={(spokenKeys) => patch({ dictation: { spokenKeys } })}
        label="“Press enter” and “send it”"
        hint="End a dictation with “…, send it” or “… Press enter.” to press Enter after typing. Never in a terminal. “Stop dictation” just ends it."
      />
      <NumberField
        label="Hands-free stops after a pause of"
        value={d.silenceSec}
        min={1}
        max={10}
        step={0.5}
        unit="s"
        hint="Double-tap the dictation shortcut for hands-free dictation."
        onCommit={(silenceSec) => patch({ dictation: { silenceSec } })}
      />
      <Select
        label="Hold a mouse button to dictate"
        value={d.mouseButton}
        options={MOUSE_OPTIONS}
        onChange={(mouseButton) => patch({ dictation: { mouseButton } })}
        hint="Works like the dictation shortcut: hold to talk, double-click for hands-free. The button does nothing else while this is on."
      />
    </Card>
  )
}
