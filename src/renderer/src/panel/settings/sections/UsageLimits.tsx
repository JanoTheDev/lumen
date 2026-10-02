// Settings → Usage → Monthly limits (05 T45): overall cap (USD and tokens for free / local
// models), one per automation, buddy caps read-only (each buddy's page edits its budget), and
// this month's progress toward each.
import { useCallback, useEffect, useState } from 'react'
import type { UsageLimitRow, UsageLimitsView } from '@shared/usage'
import { Card, NumberField, ProgressBar } from '../../../ui'
import { useIpc } from '../../../lib/ipc'
import type { SectionProps } from '../meta'
import { fieldToTokens, hasCap, limitProgressText, tokensToField } from './usage-limits-view'

function Progress({ row }: { row: UsageLimitRow }): JSX.Element {
  const text = limitProgressText(row)
  return hasCap(row) ? (
    <ProgressBar label={row.name} value={Math.min(1, row.ratio)} valueText={text} />
  ) : (
    <p className="ui-hint">
      {row.name}: {text}
    </p>
  )
}

export function UsageLimits({ cfg, patch }: SectionProps): JSX.Element {
  const [view, setView] = useState<UsageLimitsView | null>(null)
  const refresh = useCallback(() => {
    window.lumen
      .invoke('usage:limits')
      .then((v) => 'overall' in v && setView(v))
      .catch(() => {})
  }, [])
  const limits = cfg.usage.limits
  // Re-read after a cap changes too (the level depends on it).
  useEffect(refresh, [refresh, limits])
  useIpc('usage:changed', refresh)

  const setAutomation = (id: string, cap: { usd?: number; tokens?: number }): void => {
    patch({ usage: { limits: { automations: { [id]: { ...limits.automations[id], ...cap } } } } })
  }

  return (
    <Card
      title="Monthly limits"
      description="Optional caps for this calendar month. At 80% you get a note in the Tasks list; at 100% automations and buddies pause until next month. Questions you ask yourself are never blocked, only warned. 0 means no limit."
    >
      <NumberField
        label="Monthly limit, all of Lumen"
        value={limits.monthlyUsd ?? 0}
        min={0}
        max={10000}
        step={1}
        unit="$"
        onCommit={(v) => patch({ usage: { limits: { monthlyUsd: v } } })}
      />
      <NumberField
        label="Monthly token limit, all of Lumen"
        value={tokensToField(limits.monthlyTokens)}
        min={0}
        max={1_000_000}
        step={100}
        unit="k tokens"
        hint="For free or local models, where cost stays $0. Input + output tokens."
        onCommit={(v) => patch({ usage: { limits: { monthlyTokens: fieldToTokens(v) } } })}
      />
      {view && <Progress row={view.overall} />}
      {view && view.automations.length > 0 && (
        <details>
          <summary>Per automation</summary>
          {view.automations.map((a) => (
            <div key={a.id} className="usage-limit">
              <NumberField
                label={`${a.name}: monthly limit`}
                value={limits.automations[a.id]?.usd ?? 0}
                min={0}
                max={1000}
                step={0.5}
                unit="$"
                onCommit={(usd) => setAutomation(a.id, { usd })}
              />
              <NumberField
                label={`${a.name}: token limit`}
                value={tokensToField(limits.automations[a.id]?.tokens)}
                min={0}
                max={1_000_000}
                step={100}
                unit="k tokens"
                onCommit={(k) => setAutomation(a.id, { tokens: fieldToTokens(k) })}
              />
              <Progress row={a} />
            </div>
          ))}
        </details>
      )}
      {view && view.buddies.length > 0 && (
        <details>
          <summary>Buddies</summary>
          <p className="ui-hint">Each buddy’s monthly budget is set on its own page.</p>
          {view.buddies.map((b) => (
            <Progress key={b.id} row={b} />
          ))}
        </details>
      )}
    </Card>
  )
}
