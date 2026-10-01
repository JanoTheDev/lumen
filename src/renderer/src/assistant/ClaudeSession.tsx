// Focused Claude Code session on the bar (08 T39): the status line, what Claude did lately (the
// step list's look), and what waits for the user: a permission with Allow / Always / Deny
// (unless the confirm card above already asks it), or Claude's question with its options.
// Typing is not offered here (the bar does not take focus); the hint names the voice phrases.
import type { ClaudeBarView } from '@shared/claude-code'
import { Button, icons } from '../ui'
import { invoke } from '../lib/ipc'

const WORKING = new Set(['starting', 'thinking', 'running-tool'])

export function ClaudeSession({
  s,
  confirmShown
}: {
  s: ClaudeBarView
  confirmShown: boolean
}): JSX.Element {
  const working = WORKING.has(s.phase)
  const p = s.pending
  const permit = (answer: 'once' | 'always' | 'deny'): void => {
    if (p?.permId) void invoke('claude:permission-answer', { id: p.permId, answer }).catch(() => {})
  }
  const reply = (text: string): void =>
    void invoke('claude:send', { id: s.id, text }).catch(() => {})
  return (
    <div className="as-row as-steps as-claude">
      <p className="as-steps__summary">{s.status}</p>
      {s.lines.length > 0 && (
        <ol className="as-steps__list" aria-label={`What Claude did in ${s.projectName}`}>
          {s.lines.map((line, i) => {
            const now = working && i === s.lines.length - 1
            const Icon = now ? icons.play : icons.check
            return (
              <li key={`${i}-${line}`} className={`as-steps__item is-${now ? 'running' : 'done'}`}>
                <span className="as-steps__icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="as-steps__label">{line}</span>
              </li>
            )
          })}
        </ol>
      )}
      {p?.kind === 'permission' && !confirmShown && p.permId && (
        <div className="as-steps__question">
          <p>{p.command ?? p.text}</p>
          <Button variant="primary" onClick={() => permit('once')}>
            Allow
          </Button>
          <Button onClick={() => permit('always')}>Always allow</Button>
          <Button onClick={() => permit('deny')}>Deny</Button>
        </div>
      )}
      {p?.kind === 'question' && (
        <div className="as-steps__question">
          <p>{p.text}</p>
          {p.choices?.map((c) => (
            <Button key={c} onClick={() => reply(c)}>
              {c}
            </Button>
          ))}
        </div>
      )}
      <p className="as-claude__hint">
        {p?.kind === 'question'
          ? 'Say “answer …” to reply.'
          : 'Say “tell Claude …” for a follow-up.'}
      </p>
      {working && (
        <Button
          icon={icons.square}
          onClick={() => void invoke('claude:interrupt', s.id).catch(() => {})}
        >
          Stop Claude
        </Button>
      )}
    </div>
  )
}
