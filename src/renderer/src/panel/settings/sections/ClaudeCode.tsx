// Settings → Claude Code (08 T40): the user's own `claude` CLI, autopilot defaults, allowed
// tools, projects, live sessions with waiting permissions, and the opt-in global hooks (T38)
// whose exact settings.json diff is shown before anything is written.
import { useCallback, useEffect, useState } from 'react'
import type { ClaudeStatus } from '@shared/channels'
import type {
  AutopilotLevel,
  ClaudeHooksPreview,
  ClaudeProject,
  ClaudeSettingsPatch
} from '@shared/claude-code'
import { Button, Card, Field, SegmentedControl, Select, Switch, announce, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'
import { CodingSkills } from './CodingSkills'

const LEVELS: { value: AutopilotLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'careful', label: 'Careful' },
  { value: 'full', label: 'Full' }
]

const LEVEL_HINT: Record<AutopilotLevel, string> = {
  off: 'Every permission prompt and every question from Claude comes to you.',
  careful:
    'Lumen approves reads, searches, edits inside the project and test, lint and typecheck commands, and answers questions only when the answer is clear. Installs, network, git push, deletes and anything outside the project ask you.',
  full: 'Lumen approves everything except the hard list and answers what it can. Product, money and irreversible decisions still come to you.'
}

const PHASE_TEXT: Record<string, string> = {
  starting: 'Starting',
  thinking: 'Thinking',
  'running-tool': 'Working',
  'waiting-permission': 'Waiting for your OK',
  'waiting-answer': 'Has a question',
  idle: 'Done',
  stopped: 'Stopped',
  failed: 'Stopped with an error'
}

function TextSetting({
  label,
  hint,
  value,
  placeholder,
  multiline,
  onSave
}: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  multiline?: boolean
  onSave: (v: string) => void
}): JSX.Element {
  // The parent keys this by `value`, so a saved change starts a fresh draft.
  const [text, setText] = useState(value)
  const save = (): void => {
    if (text !== value) onSave(text)
  }
  return (
    <Field label={label} hint={hint}>
      {(a) =>
        multiline ? (
          <textarea
            {...a}
            className="ui-input ui-input--mono"
            rows={4}
            spellCheck={false}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
          />
        ) : (
          <input
            {...a}
            className="ui-input ui-input--mono"
            spellCheck={false}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        )
      }
    </Field>
  )
}

function HooksCard({
  enabled,
  answer,
  waitS,
  refresh
}: {
  enabled: boolean
  answer: boolean
  waitS: number
  refresh: () => void
}): JSX.Element {
  const [preview, setPreview] = useState<(ClaudeHooksPreview & { install: boolean }) | null>(null)
  const [msg, setMsg] = useState('')

  const show = async (install: boolean): Promise<void> => {
    setMsg('')
    const p = await invoke('claude:hooks-preview', install)
    if ('error' in p) {
      setMsg(p.error)
      return
    }
    setPreview({ ...p, install })
  }

  const apply = async (): Promise<void> => {
    if (!preview) return
    const r = await invoke('claude:hooks-apply', preview.install, preview.hash)
    const text = r.ok
      ? preview.install
        ? 'Hooks added. Claude sessions you start yourself now tell Lumen when they finish or need you.'
        : 'Lumen’s hooks were removed.'
      : (r.error ?? 'Nothing was changed.')
    setMsg(text)
    announce(text, r.ok ? 'polite' : 'assertive')
    setPreview(null)
    refresh()
  }

  // The PermissionRequest hook is part of the installed hooks: a change is a new diff to confirm.
  const setAnswer = async (patch: ClaudeSettingsPatch): Promise<void> => {
    await invoke('claude:settings-set', patch)
    refresh()
    if (enabled) await show(true)
  }

  return (
    <Card
      title="Sessions you start yourself"
      description="Optional: Lumen adds three small hooks (Notification, Stop, SubagentStop) to ~/.claude/settings.json, so it can say “Claude finished in …” or “Claude needs you” for terminal sessions too. They only talk to Lumen on this PC. Sessions Lumen starts need nothing here."
    >
      <Switch
        checked={enabled}
        label="Tell me about sessions I start in the terminal"
        hint="You see the exact change before anything is written. Turning it off removes only Lumen’s entries."
        onChange={(on) => void show(on)}
      />
      <Switch
        checked={answer}
        label="Let me answer their permission prompts by voice"
        hint="Claude waits for your “approve” or “deny” on Lumen’s bar; if you do not answer in time, or you are away, Claude shows its own prompt in the terminal."
        onChange={(on) => void setAnswer({ hooksPermissions: on })}
      />
      {answer && (
        <Select
          label="Wait for my answer"
          value={String(waitS)}
          options={[
            { value: '20', label: '20 seconds' },
            { value: '45', label: '45 seconds' },
            { value: '90', label: '90 seconds' },
            { value: '180', label: '3 minutes' }
          ]}
          onChange={(v) => void setAnswer({ hooksPermissionWaitS: Number(v) })}
        />
      )}
      {preview && (
        <div className="panel-stack">
          <p className="ui-hint">
            {preview.install ? 'This change will be made to' : 'This will be removed from'}{' '}
            <code>{preview.path}</code>
            {preview.stale ? ' (the installed hooks point at an old port; this updates them)' : ''}:
          </p>
          <pre className="ui-input ui-input--mono" tabIndex={0} aria-label="Settings file change">
            {preview.diff || '(no change)'}
          </pre>
          <div className="panel-row">
            <Button variant="primary" icon={icons.check} onClick={() => void apply()}>
              {preview.install ? 'Add the hooks' : 'Remove the hooks'}
            </Button>
            <Button variant="quiet" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && <p className="ui-hint">{msg}</p>}
    </Card>
  )
}

export function ClaudeCode(): JSX.Element {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [projects, setProjects] = useState<ClaudeProject[]>([])
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    invoke('claude:status')
      .then(setStatus)
      .catch(() => {})
    invoke('claude:projects')
      .then(setProjects)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  // Live sessions change on their own: a light poll while the page is open.
  useEffect(() => {
    const t = setInterval(() => {
      invoke('claude:status')
        .then(setStatus)
        .catch(() => {})
    }, 2500)
    return () => clearInterval(t)
  }, [])

  const set = (patch: ClaudeSettingsPatch): void => {
    invoke('claude:settings-set', patch)
      .then(() => refresh())
      .catch(() => {})
  }

  const say = (text: string, ok = true): void => {
    setMsg(text)
    announce(text, ok ? 'polite' : 'assertive')
  }

  const addFolder = async (): Promise<void> => {
    const path = await invoke('claude:pick-folder')
    if (!path) return
    const r = await invoke('claude:project-set', { path })
    say(r.ok ? 'Project added.' : (r.error ?? 'Could not add it.'), r.ok)
    refresh()
  }

  const setProject = async (p: ClaudeProject, level: AutopilotLevel | ''): Promise<void> => {
    await invoke('claude:project-set', {
      path: p.path,
      ...(p.source === 'user' || p.name ? { name: p.name } : {}),
      ...(level ? { autopilot: level } : {}),
      ...(p.allowedTools ? { allowedTools: p.allowedTools } : {}),
      ...(p.notes ? { notes: p.notes } : {})
    })
    refresh()
  }

  const open = async (p: ClaudeProject): Promise<void> => {
    const r = await invoke('claude:open', { project: p.path })
    say(r.ok ? `Claude is open in ${p.name}.` : (r.error ?? 'Could not start Claude.'), r.ok)
    refresh()
  }

  if (!status) return <p className="ui-hint">Checking…</p>
  const s = status.settings
  const cli = status.cli

  return (
    <>
      <Card
        title="Claude Code"
        description="Lumen drives the Claude Code you already use, with your own login. It costs nothing extra in Lumen; Claude Code’s own usage applies. Nothing is installed for you."
      >
        <div className={cli.found ? 'panel-note is-ok' : 'panel-note'} role="status">
          {cli.found ? <icons.checkCircle /> : <icons.info />}
          <span>
            {cli.found ? (
              `Found ${cli.path}${cli.version ? ` (version ${cli.version})` : ''}.`
            ) : (
              <>
                Claude Code is not installed.{' '}
                <a href={cli.installUrl} target="_blank" rel="noreferrer">
                  How to install it
                </a>
                .
              </>
            )}
          </span>
        </div>
        <TextSetting
          key={`cli:${s.cliPath}`}
          label="Path to claude"
          hint="Leave empty to find it on PATH or in the usual install folders."
          placeholder="C:\Users\you\.local\bin\claude.exe"
          value={s.cliPath}
          onSave={(cliPath) => set({ cliPath: cliPath.trim() })}
        />
        <TextSetting
          key={`model:${s.model}`}
          label="Model for new sessions"
          hint="Empty uses your Claude Code default. Examples: sonnet, opus."
          value={s.model}
          onSave={(model) => set({ model: model.trim() })}
        />
        <div className="panel-row">
          <Button icon={icons.repeat} onClick={refresh}>
            Check again
          </Button>
        </div>
      </Card>

      <Card
        title="Autopilot"
        description="How much Lumen decides for you. Say “autopilot on”, “autopilot careful” or “pause autopilot” any time."
      >
        <SegmentedControl
          label="Default level"
          value={s.autopilot}
          options={LEVELS}
          onChange={(autopilot) => set({ autopilot })}
          hint={LEVEL_HINT[s.autopilot]}
        />
        <p className="ui-hint">
          Always asks you, at every level, with the exact command: force push, rewriting git
          history, deleting outside the project, credential files, publishing or deploying, spending
          money, and messages to other people. When you are away these are refused.
        </p>
        <Select
          label="Answer Claude’s questions when Lumen is at least"
          value={String(s.confidence)}
          options={[
            { value: '0.7', label: '70% sure' },
            { value: '0.8', label: '80% sure' },
            { value: '0.9', label: '90% sure' },
            { value: '1', label: 'Never (always ask me)' }
          ]}
          onChange={(v) => set({ confidence: Number(v) })}
        />
        <Select
          label="Stop one task after it costs"
          hint="Claude’s cost comes from your Claude plan and shows in the Tasks list. Lumen only stops a task at a limit you set."
          value={String(s.taskMaxCostUsd)}
          options={[
            { value: '0', label: 'No limit' },
            { value: '1', label: '$1' },
            { value: '5', label: '$5' },
            { value: '20', label: '$20' }
          ]}
          onChange={(v) => set({ taskMaxCostUsd: Number(v) })}
        />
        <Select
          label="Stop one task after"
          value={String(s.taskMaxMin)}
          options={[
            { value: '0', label: 'No limit' },
            { value: '15', label: '15 minutes' },
            { value: '30', label: '30 minutes' },
            { value: '60', label: '1 hour' },
            { value: '120', label: '2 hours' }
          ]}
          onChange={(v) => set({ taskMaxMin: Number(v) })}
        />
        <TextSetting
          key={`tools:${s.allowedTools.join(',')}`}
          label="Always allowed tools"
          hint="One Claude Code rule per line, e.g. Bash(npm run build *). Passed as --allowedTools."
          multiline
          value={s.allowedTools.join('\n')}
          onSave={(t) =>
            set({
              allowedTools: t
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
            })
          }
        />
      </Card>

      <Card
        title="Projects"
        description="Folders Claude Code has worked in, plus your own. Say “open <name> in Claude”."
        actions={
          <Button icon={icons.download} onClick={() => void addFolder()}>
            Add a folder
          </Button>
        }
      >
        {projects.length === 0 && <p className="ui-hint">No projects yet.</p>}
        <ul className="panel-list">
          {projects.map((p) => (
            <li key={p.path} className="panel-row">
              <span>
                <strong>{p.name}</strong>
                <br />
                <span className="ui-hint">{p.path}</span>
              </span>
              <select
                className="ui-select"
                aria-label={`Autopilot for ${p.name}`}
                value={p.autopilot ?? ''}
                onChange={(e) => void setProject(p, e.target.value as AutopilotLevel | '')}
              >
                <option value="">Default autopilot</option>
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <Button disabled={!cli.found} onClick={() => void open(p)}>
                Open in Claude
              </Button>
              {p.source === 'user' && (
                <Button
                  variant="quiet"
                  icon={icons.trash}
                  aria-label={`Remove ${p.name}`}
                  onClick={() => {
                    void invoke('claude:project-remove', p.path).then(refresh)
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <CodingSkills projects={projects} />

      <Card title="Sessions" description="Claude Code sessions Lumen is running now.">
        {status.sessions.length === 0 && <p className="ui-hint">None running.</p>}
        <ul className="panel-list">
          {status.sessions.map((v) => (
            <li key={v.id} className="panel-stack">
              <span>
                <strong>{v.title}</strong> · {PHASE_TEXT[v.phase] ?? v.phase} · autopilot{' '}
                {v.autopilot}
                {v.costUsd ? ` · $${v.costUsd.toFixed(2)}` : ''}
              </span>
              {v.lastLine && <span className="ui-hint">{v.lastLine}</span>}
              {v.autoAnswers.slice(-3).map((a) => (
                <span key={a.at} className="ui-hint">
                  I answered “{a.answer}” {a.reason}
                </span>
              ))}
              <div className="panel-row">
                <Button
                  icon={icons.square}
                  onClick={() => void invoke('claude:interrupt', v.id).then(refresh)}
                >
                  Stop
                </Button>
                <Button
                  variant="quiet"
                  icon={icons.close}
                  onClick={() => void invoke('claude:close', v.id).then(refresh)}
                >
                  Close
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {status.pending.map((p) => (
          <div key={p.id} className="panel-note" role="alert">
            <icons.alert />
            <span>
              Claude in {p.projectName} wants: <code>{p.what}</code> ({p.reason})
            </span>
            <div className="panel-row">
              <Button
                variant="primary"
                onClick={() =>
                  void invoke('claude:permission-answer', { id: p.id, answer: 'once' })
                }
              >
                Allow
              </Button>
              {!p.hard && (
                <Button
                  onClick={() =>
                    void invoke('claude:permission-answer', { id: p.id, answer: 'always' })
                  }
                >
                  Always this session
                </Button>
              )}
              <Button
                variant="quiet"
                onClick={() =>
                  void invoke('claude:permission-answer', { id: p.id, answer: 'deny' })
                }
              >
                Deny
              </Button>
            </div>
          </div>
        ))}
        {msg && <p className="ui-hint">{msg}</p>}
      </Card>

      <HooksCard
        enabled={s.hooksObserver}
        answer={s.hooksPermissions}
        waitS={s.hooksPermissionWaitS}
        refresh={refresh}
      />
    </>
  )
}
