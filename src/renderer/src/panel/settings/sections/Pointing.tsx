// Settings → Smart helpers → Point and say (11 T15): "click this", "move this there",
// "what's that". The pointer is only watched (in memory, the last 10 seconds) while this is on.
import type { HelpersConfig } from '@shared/config'
import { Card, Switch } from '../../../ui'

export function Pointing({
  h,
  set
}: {
  h: HelpersConfig
  set: (p: Partial<HelpersConfig>) => void
}): JSX.Element {
  return (
    <Card
      title="Point and say"
      description="Point with the mouse, head pointer or eye gaze while you talk: “click this”, “double click that”, “move this… there”, “what’s that?”. Lumen matches each word to where the pointer was when you said it."
    >
      <Switch
        checked={h.deictic}
        onChange={(deictic) => set({ deictic })}
        label="Understand “this”, “that” and “there”"
        hint="While on, where the pointer was in the last 10 seconds is kept in memory. Nothing is saved or sent."
      />
    </Card>
  )
}
