// Settings → Usage (05 T44): what Lumen's model, search and cloud speech calls cost, from the
// local usage ledger. Tables first (sortable, each row opens its calls), then a per-day stacked
// bar chart; Claude Code spend in its own group; CSV export (counts only).
import { useCallback, useEffect, useState } from 'react'
import type {
  UsageCalls,
  UsageCallsFilter,
  UsageGroup,
  UsageRange,
  UsageReport,
  UsageTableRow
} from '@shared/usage'
import { USAGE_GROUPS, USAGE_RANGES } from '@shared/usage'
import { Button, Card, SegmentedControl, announce } from '../../../ui'
import { useIpc } from '../../../lib/ipc'
import {
  BUCKET_LABEL,
  GROUP_LABEL,
  RANGE_LABEL,
  chartGeometry,
  chartSummary,
  metricText,
  money,
  notes,
  percent,
  sortRows,
  sumTokens,
  tokens,
  type ChartMetric,
  type SortKey
} from './usage-view'
import type { SectionProps } from '../meta'
import { UsageLimits } from './UsageLimits'
import './usage.css'

const RANGE_OPTIONS = USAGE_RANGES.map((value) => ({ value, label: RANGE_LABEL[value] }))
const GROUP_OPTIONS = USAGE_GROUPS.map((value) => ({ value, label: GROUP_LABEL[value] }))

interface Drill {
  filter: UsageCallsFilter
  title: string
}

function Tiles({ r }: { r: UsageReport }): JSX.Element {
  const s = r.sums
  const tiles: Array<[string, string, string?]> = [
    ['Spend', money(s.usd), 'estimate from list prices'],
    ['Tokens', tokens(sumTokens(s)), `${tokens(s.in)} in · ${tokens(s.out)} out`],
    ['Calls', String(s.calls), s.searches ? `${s.searches} web searches` : undefined],
    ['Cache hits', percent(r.cacheHitRate), 'of input tokens read from cache']
  ]
  return (
    <dl className="usage-tiles">
      {tiles.map(([label, value, hint]) => (
        <div key={label} className="usage-tile">
          <dt>{label}</dt>
          <dd className="usage-tile__value">{value}</dd>
          {hint && <dd className="ui-hint">{hint}</dd>}
        </div>
      ))}
    </dl>
  )
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  numeric
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (k: SortKey) => void
  numeric?: boolean
}): JSX.Element {
  const on = sort.key === k
  return (
    <th
      scope="col"
      className={numeric ? 'usage-num' : undefined}
      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="usage-sort" onClick={() => onSort(k)}>
        {label}
        <span aria-hidden="true">{on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  )
}

function CostCell({ row }: { row: UsageTableRow }): JSX.Element {
  return (
    <td className="usage-num">
      {money(row.sums.usd)}
      {row.sums.unpriced > 0 && <span className="usage-flag"> no price</span>}
    </td>
  )
}

export function UsageTable({
  caption,
  rows,
  nameLabel,
  onOpen
}: {
  caption: string
  rows: UsageTableRow[]
  nameLabel: string
  onOpen: (row: UsageTableRow) => void
}): JSX.Element {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'usd',
    dir: 'desc'
  })
  const onSort = (key: SortKey): void =>
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc'
    }))
  if (!rows.length) return <p className="ui-hint">Nothing in this range.</p>
  return (
    <div className="usage-scroll">
      <table className="panel-table usage-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <SortHead label={nameLabel} k="name" sort={sort} onSort={onSort} />
            <SortHead label="Calls" k="calls" sort={sort} onSort={onSort} numeric />
            <SortHead label="Tokens" k="tokens" sort={sort} onSort={onSort} numeric />
            <SortHead label="Cost" k="usd" sort={sort} onSort={onSort} numeric />
          </tr>
        </thead>
        <tbody>
          {sortRows(rows, sort.key, sort.dir).map((r) => (
            <tr key={r.key}>
              <th scope="row">
                <button
                  type="button"
                  className="usage-link"
                  title={r.name !== r.key ? r.key : undefined}
                  onClick={() => onOpen(r)}
                >
                  {r.name}
                </button>
              </th>
              <td className="usage-num">{r.sums.calls}</td>
              <td className="usage-num">{tokens(sumTokens(r.sums))}</td>
              <CostCell row={r} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const time = (t: number): string =>
  new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

function Calls({
  drill,
  range,
  stamp,
  onClose
}: {
  drill: Drill
  range: UsageRange
  /** The report the page shows: a new one re-reads the calls. */
  stamp: unknown
  onClose: () => void
}): JSX.Element {
  const [calls, setCalls] = useState<UsageCalls | null>(null)
  useEffect(() => {
    let live = true
    window.lumen
      .invoke('usage:calls', { range, filter: drill.filter })
      .then((c) => live && setCalls('rows' in c ? c : { rows: [], total: 0 }))
      .catch(() => live && setCalls({ rows: [], total: 0 }))
    return () => {
      live = false
    }
  }, [drill, range, stamp])
  return (
    <Card
      level={3}
      title={`Calls: ${drill.title}`}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {!calls ? (
        <p className="ui-hint">Loading…</p>
      ) : !calls.rows.length ? (
        <p className="ui-hint">No calls.</p>
      ) : (
        <>
          {calls.total > calls.rows.length && (
            <p className="ui-hint">
              Newest {calls.rows.length} of {calls.total} calls.
            </p>
          )}
          <div className="usage-scroll">
            <table className="panel-table usage-table">
              <caption className="visually-hidden">Calls for {drill.title}, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Model</th>
                  <th scope="col">Feature</th>
                  <th scope="col" className="usage-num">
                    In
                  </th>
                  <th scope="col" className="usage-num">
                    Out
                  </th>
                  <th scope="col" className="usage-num">
                    Cache
                  </th>
                  <th scope="col" className="usage-num">
                    Cost
                  </th>
                  <th scope="col">Task</th>
                </tr>
              </thead>
              <tbody>
                {calls.rows.map((c, i) => (
                  <tr key={`${c.t}-${i}`}>
                    <th scope="row">{time(c.t)}</th>
                    <td>{c.model}</td>
                    <td>{c.feature}</td>
                    <td className="usage-num">{tokens(c.in)}</td>
                    <td className="usage-num">{tokens(c.out)}</td>
                    <td className="usage-num">{tokens(c.cacheRead + c.cacheWrite)}</td>
                    <td className="usage-num">
                      {c.free ? '$0 (free)' : money(c.usd)}
                      {!c.priced && <span className="usage-flag"> no price</span>}
                    </td>
                    <td>
                      {c.taskId ? (
                        <a href={`#/tasks/${c.taskId}`} className="usage-link">
                          Open
                        </a>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

const CHART_W = 600
const CHART_H = 160

export function DayChart({
  r,
  onDay
}: {
  r: UsageReport
  onDay: (day: string, label: string) => void
}): JSX.Element {
  const [metric, setMetric] = useState<ChartMetric>(r.sums.usd > 0 ? 'usd' : 'tokens')
  const g = chartGeometry(r.days, metric, CHART_W, CHART_H)
  return (
    <>
      <SegmentedControl<ChartMetric>
        label="Show"
        value={metric}
        options={[
          { value: 'usd', label: 'Cost' },
          { value: 'tokens', label: 'Tokens' }
        ]}
        onChange={setMetric}
      />
      {g.max > 0 ? (
        <>
          <svg
            className="usage-chart"
            viewBox={`0 0 ${CHART_W} ${CHART_H + 20}`}
            role="img"
            aria-label={chartSummary(g, metric)}
          >
            <line className="usage-chart__base" x1={0} x2={CHART_W} y1={CHART_H} y2={CHART_H} />
            {g.bars.map((b, i) => (
              <g key={b.day} onClick={() => b.total > 0 && onDay(b.day, b.label)}>
                <title>{`${b.label}: ${metricText(metric, b.total)}`}</title>
                {/* hit target taller than the marks */}
                <rect
                  x={b.x - 2}
                  y={0}
                  width={g.barWidth + 4}
                  height={CHART_H}
                  className="usage-chart__hit"
                />
                {b.segments.map((s) => (
                  <rect
                    key={s.bucket}
                    x={b.x}
                    y={s.y}
                    width={g.barWidth}
                    height={s.h}
                    rx={Math.min(2, g.barWidth / 4)}
                    className={`usage-chart__seg is-${s.bucket}`}
                  />
                ))}
                {(g.bars.length <= 8 || i % Math.ceil(g.bars.length / 8) === 0) && (
                  <text
                    x={b.x + g.barWidth / 2}
                    y={CHART_H + 14}
                    textAnchor="middle"
                    className="usage-chart__label"
                  >
                    {b.label}
                  </text>
                )}
              </g>
            ))}
          </svg>
          <ul className="usage-legend" aria-label="Legend">
            {g.buckets.map((b) => (
              <li key={b}>
                <span className={`usage-swatch is-${b}`} aria-hidden="true" />
                {BUCKET_LABEL[b]}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="ui-hint">No use in this range.</p>
      )}
      <details>
        <summary>Per day as a table</summary>
        <div className="usage-scroll">
          <table className="panel-table usage-table">
            <caption className="visually-hidden">Per day by who asked</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {g.buckets.map((b) => (
                  <th key={b} scope="col" className="usage-num">
                    {BUCKET_LABEL[b]}
                  </th>
                ))}
                <th scope="col" className="usage-num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {g.bars.map((b, i) => (
                <tr key={b.day}>
                  <th scope="row">
                    {b.total > 0 ? (
                      <button
                        type="button"
                        className="usage-link"
                        onClick={() => onDay(b.day, b.label)}
                      >
                        {b.label}
                      </button>
                    ) : (
                      b.label
                    )}
                  </th>
                  {g.buckets.map((k) => (
                    <td key={k} className="usage-num">
                      {metricText(metric, r.days[i][metric][k])}
                    </td>
                  ))}
                  <td className="usage-num">{metricText(metric, b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}

function ClaudeCodeGroup({
  r,
  onOpen
}: {
  r: NonNullable<UsageReport['claudeCode']>
  onOpen: (row: UsageTableRow) => void
}): JSX.Element {
  return (
    <Card
      title="Claude Code (your subscription / your key)"
      description="Turns of Claude Code sessions Lumen drove. Paid through your own Claude Code login or key, so they are not part of Lumen’s spend above."
    >
      <p className="panel-list__title">
        {money(r.sums.usd)} · {tokens(sumTokens(r.sums))} tokens · {r.sums.calls}{' '}
        {r.sums.calls === 1 ? 'turn' : 'turns'}
      </p>
      <UsageTable
        caption="Claude Code sessions"
        nameLabel="Session"
        rows={r.sessions}
        onOpen={onOpen}
      />
    </Card>
  )
}

export function Usage({ cfg, patch }: SectionProps): JSX.Element {
  const [range, setRange] = useState<UsageRange>('7d')
  const [group, setGroup] = useState<UsageGroup>('feature')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [drill, setDrill] = useState<Drill | null>(null)

  const refresh = useCallback(() => {
    window.lumen
      .invoke('usage:report', { range })
      .then((r) => 'sums' in r && setReport(r))
      .catch(() => {})
  }, [range])
  useEffect(refresh, [refresh])
  useIpc('usage:changed', refresh)

  const exportCsv = async (): Promise<void> => {
    const r = await window.lumen.invoke('usage:export', { range }).catch(() => null)
    if (r?.ok) announce('Usage exported.')
    else if (r?.error !== 'cancelled') announce('Couldn’t export usage.')
  }

  return (
    <>
      <Card
        title="Overview"
        description="Counted on this PC from every model, web search and cloud speech call Lumen made. Prices are list prices, so your provider’s bill is the real number. Local models and the Gemini free tier count as $0."
        actions={<Button onClick={() => void exportCsv()}>Export CSV</Button>}
      >
        <SegmentedControl<UsageRange>
          label="Range"
          value={range}
          options={RANGE_OPTIONS}
          onChange={(v) => {
            setRange(v)
            setDrill(null)
          }}
        />
        {!report ? (
          <p className="ui-hint">Loading…</p>
        ) : (
          <>
            <Tiles r={report} />
            {notes(report.sums).map((n) => (
              <p key={n} className="ui-hint">
                {n}
              </p>
            ))}
          </>
        )}
      </Card>
      <UsageLimits cfg={cfg} patch={patch} />
      {report && (
        <Card title="Where it went" description="Biggest first; pick a row to see its calls.">
          <SegmentedControl<UsageGroup>
            label="Group by"
            value={group}
            options={GROUP_OPTIONS}
            onChange={setGroup}
          />
          <UsageTable
            caption={`Usage by ${GROUP_LABEL[group].toLowerCase()}, ${RANGE_LABEL[range].toLowerCase()}`}
            nameLabel={GROUP_LABEL[group]}
            rows={report.tables[group]}
            onOpen={(row) => setDrill({ filter: { group, key: row.key }, title: row.name })}
          />
        </Card>
      )}
      {drill && <Calls drill={drill} range={range} stamp={report} onClose={() => setDrill(null)} />}
      {report && report.days.length > 1 && (
        <Card title="Per day" description="Stacked by who asked.">
          <DayChart
            key={range}
            r={report}
            onDay={(day, label) => setDrill({ filter: { group: 'day', key: day }, title: label })}
          />
        </Card>
      )}
      {report?.claudeCode && (
        <ClaudeCodeGroup
          r={report.claudeCode}
          onOpen={(row) =>
            setDrill({
              filter: { group: 'claude', key: row.key },
              title: `Claude Code ${row.name}`
            })
          }
        />
      )}
    </>
  )
}
