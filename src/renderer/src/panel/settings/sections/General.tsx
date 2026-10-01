import { Card, HotkeyField, NumberField, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

export function General({ cfg, patch }: SectionProps): JSX.Element {
  return (
    <>
      <Card title="Activation" description="How you start talking to Lumen.">
        <HotkeyField
          label="Push-to-talk shortcut"
          value={cfg.hotkey}
          onCommit={(hotkey) => patch({ hotkey })}
          hint="Hold it while you speak. Must include Ctrl, Alt or Shift, or be F1 to F12."
        />
        <Switch
          checked={cfg.handsFreeMode}
          onChange={(handsFreeMode) => patch({ handsFreeMode })}
          label="Tap to talk"
          hint="Tap the shortcut instead of holding it. Recording stops after a pause."
        />
      </Card>

      <Card title="Conversation" description="What Lumen keeps between questions.">
        <Switch
          checked={cfg.historyEnabled}
          onChange={(historyEnabled) => patch({ historyEnabled })}
          label="Remember recent questions"
        />
        <NumberField
          label="How many to remember"
          value={cfg.historyExchanges}
          min={0}
          max={20}
          unit="turns"
          onCommit={(historyExchanges) => patch({ historyExchanges })}
        />
      </Card>

      <Card title="On screen">
        <Switch
          checked={cfg.statusBubble.enabled}
          onChange={(enabled) => patch({ statusBubble: { enabled } })}
          label="Show the status bubble"
          hint="A small label at the bottom of the screen: listening, thinking, step 2 of 5."
        />
        <Switch
          checked={cfg.guideAutoDismissOnMove}
          onChange={(guideAutoDismissOnMove) => patch({ guideAutoDismissOnMove })}
          label="Clear guide highlights when the mouse moves"
          hint="Turn off to keep them until you say “done”."
        />
      </Card>
    </>
  )
}
