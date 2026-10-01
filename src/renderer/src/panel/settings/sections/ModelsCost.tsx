// Settings → Models & keys → Cost: a rough cost-per-day estimate from the local usage log.
import { useEffect, useState } from 'react'
import type { UsageOverview } from '@shared/channels'
import { Card } from '../../../ui'
import { costView } from './ModelsCostView'

export function ModelsCost(): JSX.Element {
  const [usage, setUsage] = useState<UsageOverview | null>(null)
  useEffect(() => {
    window.lumen
      .invoke('usage:get')
      .then(setUsage)
      .catch(() => {})
  }, [])
  const v = usage ? costView(usage) : null
  return (
    <Card
      title="Cost"
      description="A rough estimate from the token counts and list prices of the models Lumen called on this PC. Your provider’s bill is the real number. Local models cost nothing."
    >
      {!v ? (
        <p className="ui-hint">Loading…</p>
      ) : (
        <>
          <p className="panel-list__title">{v.estimate}</p>
          <p className="ui-hint">{v.today}</p>
          {v.recent.length > 0 && (
            <table className="panel-table">
              <caption className="ui-hint">Recent days</caption>
              <tbody>
                {v.recent.map(([day, cost]) => (
                  <tr key={day}>
                    <th scope="row">{day}</th>
                    <td>{cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {v.note && <p className="ui-hint">{v.note}</p>}
        </>
      )}
    </Card>
  )
}
