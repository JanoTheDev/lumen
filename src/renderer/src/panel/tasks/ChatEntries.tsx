// Task chat transcript (08 T43): message bubbles, collapsible tool rows, questions, results.
import type { ChatEntry, ChatHeader, SubJob } from '@shared/task-chat'
import { Button, Markdown, icons } from '../../ui'
import {
  groupEntries,
  JOB_STATUS_TEXT,
  jobLine,
  jobsLine,
  jobStepsLine,
  stepEntry,
  toolLine,
  TOOL_STATUS_TEXT
} from './chat-view'

type ToolEntry = Extract<ChatEntry, { k: 'tool' }>

const time = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function ToolIcon({ status }: { status: ToolEntry['status'] }): JSX.Element {
  const Icon =
    status === 'ok'
      ? icons.check
      : status === 'running'
        ? icons.chevronRight
        : status === 'denied'
          ? icons.shield
          : icons.error
  return (
    <span className={`chat-tool__mark is-${status}`} aria-hidden="true">
      <Icon />
    </span>
  )
}

const JOB_MARK: Record<SubJob['status'], ToolEntry['status']> = {
  queued: 'running',
  running: 'running',
  done: 'ok',
  failed: 'error',
  stopped: 'denied'
}

/** run_subagents: one collapsible group, one row per helper job (role, task, status, result). */
function JobsRow({ e, jobs }: { e: ToolEntry; jobs: SubJob[] }): JSX.Element {
  const live = jobs.some((j) => j.status === 'running' || j.status === 'queued')
  return (
    <details className="chat-tools chat-jobs" open={live || undefined}>
      <summary aria-label={`${e.label}: ${jobsLine(jobs)}`}>
        <ToolIcon status={e.status} />
        <span className="chat-tools__count">{e.label}</span>
        <span className="chat-tools__last">{jobsLine(jobs)}</span>
      </summary>
      <ol className="chat-tools__list">
        {jobs.map((j, i) => (
          <li key={i}>
            <details className="chat-tool chat-job">
              <summary aria-label={`${jobLine(j)}: ${j.task}`}>
                <ToolIcon status={JOB_MARK[j.status]} />
                <span className="chat-tool__label">
                  <span className="chat-job__role">{j.role}</span> {j.task}
                </span>
                <span className={`chat-tool__status is-${JOB_MARK[j.status]}`}>
                  {JOB_STATUS_TEXT[j.status]}
                  {j.costUsd >= 0.005 ? ` · $${j.costUsd.toFixed(2)}` : ''}
                </span>
              </summary>
              <dl className="chat-tool__detail">
                <dt>Job</dt>
                <dd>{j.task}</dd>
                {j.status === 'running' && j.step && (
                  <>
                    <dt>Now</dt>
                    <dd>{j.step}</dd>
                  </>
                )}
                {j.result && (
                  <>
                    <dt>Result</dt>
                    <dd>{j.result}</dd>
                  </>
                )}
              </dl>
              <JobSteps job={j} />
            </details>
          </li>
        ))}
      </ol>
    </details>
  )
}

/** A helper job's own steps, oldest first, each one a tool row that opens to its details. */
function JobSteps({ job }: { job: SubJob }): JSX.Element | null {
  const line = jobStepsLine(job)
  if (!line) return null
  return (
    <details className="chat-tools chat-job__steps">
      <summary>
        <span className="chat-tools__count">Steps</span>
        <span className="chat-tools__last">{line}</span>
      </summary>
      <ol className="chat-tools__list">
        {(job.steps ?? []).map((st) => (
          <li key={st.n}>
            <ToolRow e={stepEntry(st)} />
          </li>
        ))}
      </ol>
    </details>
  )
}

function ToolRow({ e }: { e: ToolEntry }): JSX.Element {
  if (e.jobs?.length) return <JobsRow e={e} jobs={e.jobs} />
  const detail = e.args || e.result
  const line = (
    <>
      <ToolIcon status={e.status} />
      <span className="chat-tool__label">{e.label}</span>
      <span className={`chat-tool__status is-${e.status}`}>{TOOL_STATUS_TEXT[e.status]}</span>
    </>
  )
  if (!detail)
    return (
      <div className="chat-tool" aria-label={toolLine(e)}>
        {line}
      </div>
    )
  return (
    <details className="chat-tool">
      <summary aria-label={toolLine(e)}>{line}</summary>
      <dl className="chat-tool__detail">
        {e.args && (
          <>
            <dt>Input</dt>
            <dd>{e.args}</dd>
          </>
        )}
        {e.result && (
          <>
            <dt>{e.status === 'ok' ? 'Result' : 'What happened'}</dt>
            <dd>{e.result}</dd>
          </>
        )}
      </dl>
    </details>
  )
}

function ToolGroup({ entries }: { entries: ToolEntry[] }): JSX.Element {
  const last = entries[entries.length - 1]
  const failed = entries.filter((e) => e.status === 'error' || e.status === 'denied').length
  const running = entries.some((e) => e.status === 'running')
  return (
    <details className="chat-tools" open={running || undefined}>
      <summary>
        <span className="chat-tools__count">{entries.length} steps</span>
        <span className="chat-tools__last">
          {failed ? `${failed} failed · ` : ''}last: {toolLine(last)}
        </span>
      </summary>
      <ol className="chat-tools__list">
        {entries.map((e) => (
          <li key={e.n}>
            <ToolRow e={e} />
          </li>
        ))}
      </ol>
    </details>
  )
}

function Question({
  e,
  header,
  onChoice
}: {
  e: Extract<ChatEntry, { k: 'question' }>
  header: ChatHeader
  onChoice: (text: string) => void
}): JSX.Element {
  const waiting = e.answer === undefined && !!header.question
  const choices = waiting
    ? header.question?.choices.length
      ? header.question.choices
      : e.choices
    : []
  return (
    <div className={`chat-card chat-question${waiting ? ' is-waiting' : ''}`}>
      <p className="chat-card__label">
        <icons.help /> {waiting ? 'Waiting for your answer' : 'Asked you'}
      </p>
      <p className="chat-question__text">{e.text}</p>
      {e.answer !== undefined && (
        <p className="chat-question__answer">
          <span className="visually-hidden">Answer: </span>
          {e.answer}
        </p>
      )}
      {!!choices?.length && (
        <div className="chat-question__choices" role="group" aria-label="Answers">
          {choices.map((c) => (
            <Button key={c} onClick={() => onChoice(c)}>
              {c}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function Entry({
  e,
  header,
  onChoice
}: {
  e: ChatEntry
  header: ChatHeader
  onChoice: (text: string) => void
}): JSX.Element {
  switch (e.k) {
    case 'user':
      return (
        <div className="chat-msg is-user">
          <p className="chat-msg__who">
            You{e.steer ? <span className="chat-msg__tag"> · while it ran</span> : null}
            <time className="chat-msg__time">{time(e.at)}</time>
          </p>
          <p className="chat-msg__text">{e.text}</p>
        </div>
      )
    case 'assistant':
      return (
        <div className="chat-msg is-assistant">
          <p className="chat-msg__who">
            {header.kind === 'claude' ? 'Claude' : 'Lumen'}
            <time className="chat-msg__time">{time(e.at)}</time>
          </p>
          <Markdown source={e.text} className="chat-msg__text" />
        </div>
      )
    case 'tool':
      return <ToolRow e={e} />
    case 'question':
      return <Question e={e} header={header} onChoice={onChoice} />
    case 'status':
      return <p className="chat-status">{e.text}</p>
    case 'error':
      return (
        <p className="chat-error">
          <icons.error /> {e.text}
        </p>
      )
    case 'result':
      return (
        <div className={`chat-card chat-result${e.ok ? '' : ' is-failed'}`}>
          <p className="chat-card__label">
            {e.ok ? <icons.checkCircle /> : <icons.error />} {e.ok ? 'Finished' : 'Stopped'}
          </p>
          <Markdown source={e.text} />
          {e.report && <Markdown source={e.report} className="chat-result__report" />}
          {e.cardsId && (
            <Button variant="quiet" onClick={() => (location.hash = `#/answer/${e.cardsId}`)}>
              View results
            </Button>
          )}
        </div>
      )
  }
}

export function ChatEntries({
  entries,
  header,
  dropped,
  onChoice
}: {
  entries: readonly ChatEntry[]
  header: ChatHeader
  dropped: number
  onChoice: (text: string) => void
}): JSX.Element {
  const items = groupEntries(entries)
  return (
    <ol className="chat-log" aria-label={`Conversation with ${header.title}`}>
      {dropped > 0 && (
        <li className="chat-status">
          {dropped} older {dropped === 1 ? 'entry was' : 'entries were'} not kept.
        </li>
      )}
      {!items.length && <li className="chat-status">Nothing yet.</li>}
      {items.map((it) =>
        it.type === 'tools' ? (
          <li key={`g${it.key}`} className="chat-item">
            <ToolGroup entries={it.entries} />
          </li>
        ) : (
          <li key={it.entry.n} className={`chat-item is-${it.entry.k}`}>
            <Entry e={it.entry} header={header} onChoice={onChoice} />
          </li>
        )
      )}
    </ol>
  )
}
