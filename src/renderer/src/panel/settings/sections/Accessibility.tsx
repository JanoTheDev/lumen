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

const ANNOUNCE = [
  { value: 'auto', label: 'On' },
  { value: 'off', label: 'Off' }
] as const

const CONFIRM_TRANSCRIPT = [
  { value: 'always', label: 'Always' },
  { value: 'risky', label: 'Only for risky actions' },
  { value: 'off', label: 'Never' }
] as const

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
  // Timings are patched as a whole object (saveConfig merges one level deep).
  const patchTimings = (next: Partial<typeof cfg.a11y.timings>): Promise<boolean> =>
    patch({ a11y: { timings: { ...cfg.a11y.timings, ...next } } })
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
        <Switch
          checked={cfg.a11y.focusNarration}
          onChange={(focusNarration) => patch({ a11y: { focusNarration } })}
          label="Read out what has focus"
          hint="Says the name of whatever the keyboard lands on. Off while a screen reader runs."
        />
      </Card>

      <Card title="Hearing" description="See what Lumen hears and says, not only hear it.">
        <Switch
          checked={cfg.a11y.captions}
          onChange={(captions) => patch({ a11y: { captions } })}
          label="Show captions"
          hint="Everything Lumen says out loud also shows as text in the bar."
        />
        <NumberField
          label="Keep “I heard” on screen"
          value={Math.round(cfg.a11y.timings.captionHoldMs / 1000)}
          min={0}
          max={600}
          unit="s"
          hint="0 keeps it until you speak again or close it."
          onCommit={(s) => patchTimings({ captionHoldMs: s * 1000 })}
        />
        <SegmentedControl
          label="Spoken updates"
          value={cfg.a11y.announce}
          options={ANNOUNCE}
          onChange={(announce) => patch({ a11y: { announce } })}
          hint="Lumen tells your screen reader, or says it out loud, what it is doing."
        />
        <div className="panel-row">
          <Button onClick={() => window.lumen.send('a11y:try', 'announce')}>Try it</Button>
        </div>
      </Card>

      <Card title="Speaking" description="When Lumen checks it heard you right.">
        <SegmentedControl
          label="Check what I said before acting"
          value={cfg.a11y.confirmTranscript}
          options={CONFIRM_TRANSCRIPT}
          onChange={(confirmTranscript) => patch({ a11y: { confirmTranscript } })}
          hint="Lumen shows “I heard: …” and waits for “yes”. Say “no, I said …” to fix it."
        />
      </Card>

      <Card
        title="Thinking and focus"
        description="More time, fewer surprises, and Lumen explains itself."
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
        <NumberField
          label="Keep status lines on screen"
          value={Math.round(cfg.a11y.timings.statusHoldMs / 1000)}
          min={4}
          max={600}
          unit="s"
          hint="The shortest time a line like “Step 2 of 5” stays."
          onCommit={(s) => patchTimings({ statusHoldMs: s * 1000 })}
        />
        <NumberField
          label="Keep answers on screen"
          value={Math.round(cfg.answerAutoCloseMs / 1000)}
          min={2}
          max={120}
          unit="s"
          hint="Pin an answer to keep it open for as long as you like."
          onCommit={(s) => patch({ answerAutoCloseMs: s * 1000 })}
        />
        <Switch
          checked={cfg.a11y.timings.confirmCountdownMs === 0}
          onChange={(wait) => patchTimings({ confirmCountdownMs: wait ? 0 : undefined })}
          label="Wait for me before acting"
          hint="Lumen never acts on its own after a countdown; it waits for “yes”."
        />
      </Card>

      <Card
        title="Moving: dwell click"
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
        title="Moving: switch scanning"
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
