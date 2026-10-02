// Settings → Diagnostics (10 T11b): a developer view of the last turn's stage timings against
// their budgets (`perf:last-turn`), read every 2 s while the section is open and the flag is on.
import { useEffect, useState } from 'react'
import type { PerfLastTurn } from '@shared/perf'
import { Card, Switch } from '../../../ui'
import type { SectionProps } from '../meta'
import { stageBar, turnSummary } from './diagnostics-view'
import './diagnostics.css'

const POLL_MS = 2000

const clock = (at: number): string => new Date(at).toLocaleTimeString()

function StageBars({ turn }: { turn: PerfLastTurn }): JSX.Element {
  return (
    <>
      <p className="ui-hint">{turnSummary(turn, clock)}</p>
      <ul className="perf-stages">
        {turn.stages.map((s) => {
          const bar = stageBar(s)
          return (
            <li key={s.name} className={bar.over ? 'perf-stage is-over' : 'perf-stage'}>
              <div className="ui-progress__head">
                <span>{bar.name}</span>
                <span className="tabular">{bar.text}</span>
              </div>
              <div
                role="meter"
                aria-label={bar.name}
                aria-valuemin={0}
                aria-valuemax={s.budgetMs}
                aria-valuenow={Math.min(s.ms, s.budgetMs)}
                aria-valuetext={bar.over ? `${bar.text}, over budget` : bar.text}
                className="ui-progress__track"
              >
                <div
                  className="ui-progress__fill perf-stage__fill"
                  style={{ transform: `scaleX(${bar.fill})` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export function Diagnostics({ cfg, patch }: SectionProps): JSX.Element {
  const on = cfg.debug.perfOverlay
  const [turn, setTurn] = useState<PerfLastTurn | null>(null)

  useEffect(() => {
    if (!on) return
    const read = (): void => {
      window.lumen
        .invoke('perf:last-turn')
        .then((t) => setTurn(t && 'stages' in t ? t : null))
        .catch(() => {})
    }
    read()
    const t = setInterval(read, POLL_MS)
    return () => clearInterval(t)
  }, [on])

  return (
    <Card
      title="Latency"
      description="For testing: how long each stage of your last question took, against its target. Kept in memory only."
    >
      <Switch
        checked={on}
        onChange={(perfOverlay) => patch({ debug: { perfOverlay } })}
        label="Show the last turn’s timings"
      />
      {on &&
        (turn ? (
          <StageBars turn={turn} />
        ) : (
          <p className="ui-hint">No question asked since Lumen started.</p>
        ))}
    </Card>
  )
}
