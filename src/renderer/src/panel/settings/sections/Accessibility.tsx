import { useEffect, useState } from 'react'
import type { ShortcutStatus } from '@shared/channels'
import { profileSummary } from '@shared/profiles'
import {
  Button,
  Card,
  HotkeyField,
  IconButton,
  NumberField,
  SegmentedControl,
  Slider,
  Switch,
  icons
} from '../../../ui'
import type { SectionProps } from '../meta'
import { FaceGestures } from './FaceGestures'
import { switchKeyClash } from './AccessibilitySwitch'
import { SwitchKeyField } from './AccessibilitySwitchField'

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

const RING_SIZES = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium' },
  { value: 'l', label: 'Large' },
  { value: 'xl', label: 'Extra large' }
] as const

/** Eye trackers and head pointers (T19): they move the system pointer, but never hold still. */
const GAZE_DWELL = { radiusPx: 30, smoothing: 0.5, snapToElement: true, ringSize: 'xl' } as const
const GAZE_DWELL_MS = 1200

const TRISTATE = [
  { value: 'system', label: 'Match Windows' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
] as const

export function Accessibility({ cfg, patch }: SectionProps): JSX.Element {
  const summary = profileSummary(cfg)
  const sw = cfg.a11y.switch
  const swKeys = sw.keys.length ? sw.keys : ['Space']
  // One key: it picks (auto scan). Two: the first moves, the second picks (step scanning).
  const setSwitchKeys = (keys: string[]): void =>
    void patch({
      a11y: { switch: { ...sw, keys, mode: keys.length > 1 ? sw.mode : 'auto' } }
    })
  const setSwitchKey = (i: number, key: string): string => {
    const clash = switchKeyClash(
      key,
      cfg,
      swKeys.filter((_, j) => j !== i)
    )
    if (!clash) setSwitchKeys(swKeys.map((k, j) => (j === i ? key : k)))
    return clash
  }
  const shortcuts = useShortcuts(cfg)
  // The whole object is patched (06 T17); '' = no shortcut.
  const setShortcut = (action: ShortcutStatus['action'], combo: string): void =>
    void patch({ a11y: { shortcuts: { ...cfg.a11y.shortcuts, [action]: combo } } })
  const [showAll, setShowAll] = useState(false)
  // Simple mode (T18): only the essentials until the user asks for everything.
  const brief = cfg.a11y.simpleMode && !showAll
  // Nested objects are patched whole (saveConfig merges one level deep).
  const patchTimings = (next: Partial<typeof cfg.a11y.timings>): Promise<boolean> =>
    patch({ a11y: { timings: { ...cfg.a11y.timings, ...next } } })
  const dwell = cfg.a11y.dwell
  const patchDwell = (next: Partial<typeof dwell>): Promise<boolean> =>
    patch({ a11y: { dwell: { ...dwell, ...next } } })
  const gazeOn =
    dwell.radiusPx >= GAZE_DWELL.radiusPx &&
    dwell.smoothing >= GAZE_DWELL.smoothing &&
    dwell.snapToElement
  const simpleCard = (
    <Card title="Simple mode" description="Fewer choices, plain words and one step at a time.">
      <Switch
        checked={cfg.a11y.simpleMode}
        onChange={(simpleMode) => patch({ a11y: { simpleMode } })}
        label="Keep things simple"
        hint="Plainer words and fewer choices. This page shows only the main options."
      />
      {cfg.a11y.simpleMode && (
        <div className="panel-row">
          <Button onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            {showAll ? 'Show fewer options' : 'Show all options'}
          </Button>
        </div>
      )}
    </Card>
  )
  if (brief) {
    return (
      <>
        {simpleCard}
        <Card title="Size" description="Make Lumen bigger or smaller.">
          <Slider
            label="Interface size"
            value={cfg.a11y.uiScale}
            min={0.75}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(uiScale) => patch({ a11y: { uiScale } })}
          />
        </Card>
        <Card title="Before Lumen acts" description="Lumen can wait for you to say yes.">
          <Switch
            checked={cfg.a11y.timings.confirmCountdownMs === 0}
            onChange={(wait) => patchTimings({ confirmCountdownMs: wait ? 0 : undefined })}
            label="Wait for me before acting"
            hint="Lumen waits for “yes” before it does anything."
          />
        </Card>
      </>
    )
  }
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

      {simpleCard}

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
        <Slider
          label="Allowed wobble"
          value={dwell.radiusPx}
          min={4}
          max={80}
          step={2}
          format={(v) => `${v} px`}
          onChange={(radiusPx) => patchDwell({ radiusPx })}
          hint="How far the pointer may drift while resting. Raise it for shaky hands or eye gaze."
        />
        <Slider
          label="Smooth the pointer"
          value={dwell.smoothing}
          min={0}
          max={0.9}
          step={0.1}
          format={(v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`)}
          onChange={(smoothing) => patchDwell({ smoothing })}
          hint="Evens out jitter before Lumen decides the pointer is resting."
        />
        <Switch
          checked={dwell.snapToElement}
          onChange={(snapToElement) => patchDwell({ snapToElement })}
          label="Snap to the nearest button"
          hint="Clicks the middle of the control under the pointer, so small targets are easier."
        />
        <SegmentedControl
          label="Ring size"
          value={dwell.ringSize}
          options={RING_SIZES}
          onChange={(ringSize) => patchDwell({ ringSize })}
        />
        <div className="panel-row">
          <Button
            onClick={() =>
              void patch({
                dwellClick: {
                  enabled: true,
                  dwellMs: Math.max(cfg.dwellClick.dwellMs, GAZE_DWELL_MS)
                },
                a11y: { dwell: { ...dwell, ...GAZE_DWELL, palette: true } }
              })
            }
            disabled={gazeOn}
          >
            {gazeOn ? 'Eye gaze settings are on' : 'Set up for eye gaze or head pointer'}
          </Button>
        </div>
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
        <SwitchKeyField
          label={swKeys.length > 1 ? 'Move switch' : 'Switch key'}
          value={swKeys[0]}
          onCommit={(key) => setSwitchKey(0, key)}
          hint={
            swKeys.length > 1
              ? 'Moves the highlight. Any single key: what your switch interface sends.'
              : 'Picks the highlighted choice. Any single key: what your switch interface sends.'
          }
        />
        {swKeys.length > 1 && (
          <SwitchKeyField
            label="Pick switch"
            value={swKeys[1]}
            onCommit={(key) => setSwitchKey(1, key)}
            hint="Picks the highlighted choice."
          />
        )}
        <div className="panel-row">
          {swKeys.length > 1 ? (
            <Button onClick={() => setSwitchKeys([swKeys[1]])}>Use one switch</Button>
          ) : (
            <Button
              onClick={() => {
                const move = swKeys[0].toLowerCase() === 'space' ? 'Enter' : 'Space'
                void patch({
                  a11y: { switch: { ...sw, keys: [move, swKeys[0]], mode: 'step' } }
                })
              }}
            >
              Add a second switch
            </Button>
          )}
        </div>
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

      <FaceGestures cfg={cfg} patch={patch} />

      <Card
        title="Keyboard shortcuts"
        description="Work anywhere in Windows. Answer keys only act while an answer shows. Select a shortcut to change it."
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
                <td>
                  <span className="panel-row">
                    <HotkeyField
                      compact
                      label={s.label}
                      value={cfg.a11y.shortcuts[s.action] ?? ''}
                      onCommit={(combo) => setShortcut(s.action, combo)}
                    />
                    {cfg.a11y.shortcuts[s.action] && (
                      <IconButton
                        icon={icons.close}
                        label={`Turn off ${s.label}`}
                        onClick={() => setShortcut(s.action, '')}
                      />
                    )}
                  </span>
                </td>
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
