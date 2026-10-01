// Settings → Privacy, actions part (08 T03/T04): agent safety settings, the "always" grants
// with Revoke, and a day-by-day viewer of the action log (~/.ai-overlay/audit).
import { useCallback, useEffect, useState } from 'react'
import type { AgentGrant, AuditLine } from '@shared/channels'
import { Button, Card, IconButton, NumberField, Switch, announce, icons } from '../../../ui'
import type { SectionProps } from '../meta'
import { auditOrigin, auditOutcome, auditWhat, dayKey, grantLabel } from './PrivacyAudit'

const AUDIT_ROWS = 200

function Grants(): JSX.Element {
  const [list, setList] = useState<AgentGrant[] | null>(null)
  const refresh = useCallback(() => {
    window.lumen
      .invoke('agent:grants-list')
      .then((l) => setList(Array.isArray(l) ? l : []))
      .catch(() => setList([]))
  }, [])
  useEffect(refresh, [refresh])

  const revoke = async (g: AgentGrant): Promise<void> => {
    const r = await window.lumen.invoke('agent:grants-revoke', g.scope).catch(() => null)
    announce(r?.ok ? `Lumen will ask again for ${grantLabel(g.scope)}.` : 'Couldn’t remove that.')
    refresh()
  }

  return (
    <Card
      title="Always allowed"
      description="Things you told Lumen to always allow. Risky actions (sending, deleting, paying) always ask, whatever is here."
    >
      {list === null ? (
        <p className="ui-hint">Loading…</p>
      ) : !list.length ? (
        <p className="ui-hint">
          Nothing yet. Say “always” or press Always on a question to add one.
        </p>
      ) : (
        <ul className="panel-list">
          {list.map((g) => (
            <li key={g.scope} className="panel-list__item">
              <div className="panel-list__text">
                <span className="panel-list__title">{grantLabel(g.scope)}</span>
                <span className="ui-hint">
                  Since{' '}
                  {new Date(g.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                </span>
              </div>
              <IconButton
                icon={icons.trash}
                variant="danger"
                label={`Stop always allowing ${grantLabel(g.scope)}`}
                onClick={() => void revoke(g)}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ActionLog({ retentionDays }: { retentionDays: number }): JSX.Element {
  const [offset, setOffset] = useState(0)
  const [loaded, setLoaded] = useState<{ day: string; lines: AuditLine[] } | null>(null)
  const day = dayKey(new Date(), offset)
  const lines = loaded?.day === day ? loaded.lines : null

  useEffect(() => {
    let live = true
    const done = (l: AuditLine[]): void => {
      if (live) setLoaded({ day, lines: l.slice(-AUDIT_ROWS).reverse() })
    }
    window.lumen
      .invoke('audit:list', { date: day })
      .then((l) => done(Array.isArray(l) ? l : []))
      .catch(() => done([]))
    return () => {
      live = false
    }
  }, [day])

  const label = offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : day
  return (
    <Card
      title="What Lumen did"
      description={`Every action Lumen did or was stopped from doing on your computer, kept on this PC for ${retentionDays} days. Typed text is kept only as its length unless you turn on keeping it above.`}
    >
      <div className="panel-row" role="group" aria-label="Day">
        <Button
          icon={icons.arrowLeft}
          disabled={offset <= -(retentionDays - 1)}
          onClick={() => setOffset((o) => o - 1)}
        >
          Earlier day
        </Button>
        <span className="panel-list__title" aria-live="polite">
          {label}
        </span>
        <Button disabled={offset >= 0} onClick={() => setOffset((o) => Math.min(0, o + 1))}>
          Later day
        </Button>
      </div>
      {lines === null ? (
        <p className="ui-hint">Loading…</p>
      ) : !lines.length ? (
        <p className="ui-hint">Nothing on this day.</p>
      ) : (
        <table className="panel-table">
          <caption className="ui-hint">
            {lines.length === AUDIT_ROWS ? `The last ${AUDIT_ROWS} actions, ` : ''}newest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">What</th>
              <th scope="col">From</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={`${l.t}-${i}`}>
                <td>
                  {new Date(l.t).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </td>
                <th scope="row">{auditWhat(l.action)}</th>
                <td>{auditOrigin(l.origin)}</td>
                <td>{auditOutcome(l)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

export function PrivacyActions({ cfg, patch }: SectionProps): JSX.Element {
  return (
    <>
      <Card title="Agent actions">
        <Switch
          checked={cfg.agent.allowSendWithoutReview}
          onChange={(allowSendWithoutReview) => patch({ agent: { allowSendWithoutReview } })}
          label="Send messages without asking"
          hint={
            cfg.agent.allowSendWithoutReview
              ? 'Careful: Lumen can now send an email or chat message after a short countdown. You won’t get to read it first unless you stop it.'
              : 'Off: Lumen always waits for your yes before it sends an email or chat message.'
          }
        />
        <Switch
          checked={cfg.audit.storeTypedText}
          onChange={(storeTypedText) => patch({ audit: { storeTypedText } })}
          label="Keep what Lumen typed in the action log"
          hint="Off by default. Passwords, keys and card numbers are always blanked out."
        />
        <NumberField
          label="Keep the action log for"
          value={cfg.audit.retentionDays}
          min={1}
          max={365}
          unit="days"
          hint="Older days are deleted the next time Lumen starts."
          onCommit={(retentionDays) => patch({ audit: { retentionDays } })}
        />
      </Card>
      <Grants />
      <ActionLog retentionDays={cfg.audit.retentionDays} />
    </>
  )
}
