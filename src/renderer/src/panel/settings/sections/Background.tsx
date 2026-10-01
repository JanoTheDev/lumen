// Settings → Background & routines (08 T22/T23/T29): limits for background tasks, the routines
// list (on/off, mouse pre-approval, run now, remove) and opt-in proactive reminders.
import { useCallback, useEffect, useState } from 'react'
import type { RoutineUpdate, RoutineView } from '@shared/routines'
import { Button, Card, IconButton, NumberField, Switch, announce, icons } from '../../../ui'
import type { SectionProps } from '../meta'

const time = (ms?: number): string =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''

const mayUseMouse = (r: RoutineView): boolean =>
  r.preApproved.some((s) => s.tool === 'request_foreground' && !s.args)

function routineMeta(r: RoutineView): string {
  const parts = [r.scheduleText]
  if (r.enabled && r.nextRunAt) parts.push(`next ${time(r.nextRunAt)}`)
  if (!r.enabled) parts.push('off')
  if (r.lastResult) parts.push(`last run ${r.lastResult}`)
  return parts.join(' · ')
}

function Routines(): JSX.Element {
  const [list, setList] = useState<RoutineView[] | null>(null)

  const refresh = useCallback(() => {
    window.lumen
      .invoke('routines:list')
      .then((l) => setList(Array.isArray(l) ? l : []))
      .catch(() => setList([]))
  }, [])
  useEffect(refresh, [refresh])

  const update = async (u: RoutineUpdate, done: string): Promise<void> => {
    const r = await window.lumen.invoke('routines:update', u).catch(() => null)
    announce(r?.ok ? done : 'Couldn’t change that routine.')
    refresh()
  }

  return (
    <Card
      title="Routines"
      description="Tasks Lumen runs on a schedule in the background, only while Lumen is open. Say for example “every weekday at 9 summarize the news on my favourite site”."
    >
      {list === null ? (
        <p className="ui-hint">Loading…</p>
      ) : !list.length ? (
        <p className="ui-hint">No routines yet.</p>
      ) : (
        <ul className="panel-list">
          {list.map((r) => (
            <li key={r.id} className="panel-list__item">
              <div className="panel-list__text">
                <span className="panel-list__title">{r.name}</span>
                <span className="ui-hint">{routineMeta(r)}</span>
                {r.disabledReason && !r.enabled && (
                  <span className="ui-hint">{r.disabledReason}</span>
                )}
                <Switch
                  checked={r.enabled}
                  onChange={(enabled) =>
                    void update({ id: r.id, enabled }, enabled ? 'Routine on' : 'Routine off')
                  }
                  label="On"
                />
                <Switch
                  checked={mayUseMouse(r)}
                  onChange={(allowForeground) =>
                    void update({ id: r.id, allowForeground }, 'Saved')
                  }
                  label="May use the mouse without asking"
                  hint="Otherwise a routine skips steps on screen. Risky steps (sending, deleting) still ask."
                />
              </div>
              <Button
                icon={icons.play}
                onClick={async () => {
                  const res = await window.lumen.invoke('routines:run-now', r.id).catch(() => null)
                  announce(
                    res?.ok ? 'Started. It shows in the Tasks list.' : 'It is already running.'
                  )
                  refresh()
                }}
              >
                Run now
              </Button>
              <IconButton
                icon={icons.trash}
                variant="danger"
                label={`Remove “${r.name}”`}
                onClick={async () => {
                  await window.lumen.invoke('routines:remove', r.id).catch(() => null)
                  announce('Routine removed')
                  refresh()
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function Background({ cfg, patch }: SectionProps): JSX.Element {
  const bg = cfg.agent.background
  const pro = cfg.agent.proactive
  const setBg = (p: Partial<typeof bg>): void =>
    void patch({ agent: { background: { ...bg, ...p } } })
  const setPro = (p: Partial<typeof pro>): void =>
    void patch({ agent: { proactive: { ...pro, ...p } } })

  return (
    <>
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
          label="Quiet"
          hint="Finished tasks wait in the Tasks list; nothing is spoken."
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

      <Routines />

      <Card
        title="Proactive reminders"
        description="Off unless you turn it on. Lumen then notices which app you switch to (only its name, never the screen) and says your reminder, for example “when I open Resolve, remind me to back up”. Nothing is recorded or sent anywhere."
      >
        <Switch
          checked={pro.enabled}
          onChange={(enabled) => setPro({ enabled })}
          label="Let Lumen speak up on its own"
          hint="Only for the reminders below. Lesson idle hints are under Lessons."
        />
        {!pro.rules.length ? (
          <p className="ui-hint">No reminders yet. Say “when I open …, remind me to …”.</p>
        ) : (
          <ul className="panel-list">
            {pro.rules.map((r) => (
              <li key={r.id} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">When I open {r.app}</span>
                  <span className="ui-hint">{r.say}</span>
                </div>
                <IconButton
                  icon={icons.trash}
                  variant="danger"
                  label={`Remove the reminder for ${r.app}`}
                  onClick={() => setPro({ rules: pro.rules.filter((x) => x.id !== r.id) })}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
