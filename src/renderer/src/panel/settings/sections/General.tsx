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
          hint="Must include Ctrl, Alt or Shift, or be F1 to F12. Hold or tap it: choose under Voice."
        />
        <HotkeyField
          label="Open Home"
          value={cfg.ui.homeHotkey ?? ''}
          onCommit={(homeHotkey) => patch({ ui: { homeHotkey } })}
          hint="Opens the Lumen panel next to the clock, from any app."
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
          checked={cfg.guideAutoDismissOnMove}
          onChange={(guideAutoDismissOnMove) => patch({ guideAutoDismissOnMove })}
          label="Clear guide highlights when the mouse moves"
          hint="Turn off to keep them until you say “done”."
        />
      </Card>

      <Card title="Windows">
        <Switch
          checked={cfg.system.startAtLogin}
          onChange={(startAtLogin) => patch({ system: { startAtLogin } })}
          label="Start Lumen when I sign in"
          hint="Starts quietly in the tray. Not available in the portable version."
        />
      </Card>
    </>
  )
}
