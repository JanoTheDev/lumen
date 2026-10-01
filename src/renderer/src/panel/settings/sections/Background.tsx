// Settings → Automations (08 T22/T23/T29): automations (time, app, file, idle and network
// triggers; Automations.tsx) and the limits every background task runs under.
import { IconButton, NumberField, Card, Switch, icons } from '../../../ui'
import type { SectionProps } from '../meta'
import { Automations } from './Automations'

export function Background({ cfg, patch }: SectionProps): JSX.Element {
  const bg = cfg.agent.background
  const setBg = (p: Partial<typeof bg>): void =>
    void patch({ agent: { background: { ...bg, ...p } } })

  return (
    <>
      <Automations />
      <Card
        title="Background tasks"
        description="Tasks that research or check things while you work. They never use the mouse or keyboard without asking."
      >
        <NumberField
          label="Tasks at once"
          value={bg.max}
          min={1}
          max={3}
          onCommit={(max) => setBg({ max })}
        />
        <NumberField
          label="Model calls per task"
          value={bg.maxModelCalls}
          min={1}
          max={200}
          hint="A task pauses and asks before going past a limit."
          onCommit={(maxModelCalls) => setBg({ maxModelCalls })}
        />
        <NumberField
          label="Cost per task"
          value={bg.maxCostUsd}
          min={0.01}
          max={5}
          step={0.01}
          unit="USD"
          onCommit={(maxCostUsd) => setBg({ maxCostUsd })}
        />
        <NumberField
          label="Time per task"
          value={bg.maxWallMin}
          min={1}
          max={120}
          unit="minutes"
          onCommit={(maxWallMin) => setBg({ maxWallMin })}
        />
        <Switch
          checked={bg.quiet}
          onChange={(quiet) => setBg({ quiet })}
          label="Quiet mode"
          hint="Finished tasks wait in the Tasks list; nothing is spoken. Say “quiet mode on” or “quiet mode off”. Focus mode (Smart helpers) is different: it dims the screen."
        />
        {bg.readFolders.length > 0 && (
          <>
            <p className="ui-hint">Folders background tasks may read:</p>
            <ul className="panel-list">
              {bg.readFolders.map((f) => (
                <li key={f} className="panel-list__item">
                  <span className="panel-list__text">{f}</span>
                  <IconButton
                    icon={icons.trash}
                    label={`Stop sharing ${f}`}
                    onClick={() => setBg({ readFolders: bg.readFolders.filter((x) => x !== f) })}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </>
  )
}
