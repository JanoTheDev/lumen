// Settings → Smart helpers (11 Phase C): focus mode, undo, shortcut coach, comfort
// proposals, error rescue, "what changed?", reading level and the learning journal. Undo is on
// from the start; every other helper is off until switched on here. All stay on this PC.
import { useCallback, useEffect, useState } from 'react'
import type { CoachStatus } from '@shared/channels'
import type { HelpersConfig, ReadingLevel } from '@shared/config'
import { Button, Card, Kbd, Markdown, NumberField, SegmentedControl, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

const LEVELS: { value: ReadingLevel; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'standard', label: 'Standard' },
  { value: 'expert', label: 'Expert' }
]

const PROPOSALS: Record<string, string> = {
  'bigger-dwell': 'Bigger dwell ring',
  numbers: 'Numbers instead of names',
  'more-help': 'More detailed hints',
  'slower-speech': 'Slower speech',
  break: 'Break reminders'
}

function useCoachStatus(): [CoachStatus | null, () => void] {
  const [status, setStatus] = useState<CoachStatus | null>(null)
  const load = useCallback(() => {
    window.lumen
      .invoke('helpers:coach-status')
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])
  useEffect(load, [load])
  return [status, load]
}

function Journal({ on }: { on: boolean }): JSX.Element {
  const [days, setDays] = useState<string[]>([])
  const [open, setOpen] = useState<{ date: string; markdown: string } | null>(null)
  const load = useCallback(() => {
    window.lumen
      .invoke('helpers:journal-days')
      .then(setDays)
      .catch(() => setDays([]))
  }, [])
  useEffect(load, [load, on])
  const show = (date: string): void => {
    window.lumen
      .invoke('helpers:journal-read', date)
      .then((r) => setOpen(r.ok && r.markdown ? { date, markdown: r.markdown } : null))
      .catch(() => setOpen(null))
  }
  const clear = (): void => {
    void window.lumen.invoke('helpers:journal-clear').then(() => {
      setOpen(null)
      load()
    })
  }
  if (!days.length) return <p className="ui-hint">No notes yet.</p>
  return (
    <>
      <ul className="panel-list" aria-label="Journal days">
        {days.slice(0, 14).map((d) => (
          <li key={d}>
            <Button variant="quiet" aria-pressed={open?.date === d} onClick={() => show(d)}>
              {d}
            </Button>
          </li>
        ))}
      </ul>
      {open && <Markdown source={open.markdown} />}
      <Button variant="danger" onClick={clear}>
        Delete all notes
      </Button>
    </>
  )
}

export function Helpers({ cfg, patch }: SectionProps): JSX.Element {
  const h = cfg.helpers
  const set = (p: Partial<HelpersConfig>): void => void patch({ helpers: p })
  const [coach, reloadCoach] = useCoachStatus()
  const apps = Object.entries(h.readingLevelApps)

  return (
    <>
      <Card
        title="Focus mode"
        description="Dims everything except what you need right now. Dimmed parts still work. Say “focus mode on”, “only show the viewport” or “show everything”."
      >
        <SegmentedControl
          label="How much to dim"
          value={h.focusLevel}
          options={[
            { value: 'soft', label: 'Soft' },
            { value: 'strong', label: 'Strong, with labels' }
          ]}
          onChange={(focusLevel) => set({ focusLevel })}
        />
        <Switch
          checked={h.focusWithLessons}
          onChange={(focusWithLessons) => set({ focusWithLessons })}
          label="Focus on each lesson step by itself"
          hint="Only the part of the app the step needs stays bright."
        />
      </Card>

      <Card
        title="Undo what Lumen did"
        description="Say “undo that”, “undo the last 3 things” or “undo what you just did”. Lumen tells you plainly what it can’t take back, like a sent email."
      >
        <Switch
          checked={h.undo}
          onChange={(undo) => set({ undo })}
          label="Remember how to undo my actions"
          hint="On from the start. Kept in memory for an hour. Before Lumen changes a file, a copy is kept for a day."
        />
      </Card>

      <Card
        title="Shortcut coach"
        description="Notices when you use a menu for something that has a shortcut, and offers it. Only menu names and shortcuts are seen, never what you type."
      >
        <Switch
          checked={h.shortcutCoach}
          onChange={(shortcutCoach) => set({ shortcutCoach })}
          label="Suggest shortcuts"
        />
        <SegmentedControl
          label="Suggest"
          value={h.coachMode}
          options={[
            { value: 'keys', label: 'Key shortcuts' },
            { value: 'voice', label: 'Voice commands instead' }
          ]}
          onChange={(coachMode) => set({ coachMode })}
          hint="Voice commands suit you better if pressing key combinations is hard."
        />
        <NumberField
          label="Suggest after"
          value={h.coachAfter}
          min={2}
          max={10}
          unit="menu uses"
          onCommit={(coachAfter) => set({ coachAfter })}
        />
        {coach && coach.learned.length > 0 && (
          <>
            <p className="ui-hint">Shortcuts you use now:</p>
            <ul className="panel-list">
              {coach.learned.map((l) => (
                <li key={`${l.app}-${l.action}`}>
                  <Kbd combo={l.combo} /> {l.action} ({l.app})
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card
        title="Comfort"
        description="Watches for signs that things are getting hard, like missed dwell clicks or being misheard, and suggests a change. Nothing changes without your yes."
      >
        <Switch
          checked={h.fatigue}
          onChange={(fatigue) => set({ fatigue })}
          label="Suggest changes when things get hard"
        />
        {coach && coach.answered.length > 0 && (
          <ul className="panel-list" aria-label="Your answers">
            {coach.answered.map((a) => (
              <li key={a.id}>
                {PROPOSALS[a.id] ?? a.id}: {a.answer === 'yes' ? 'yes' : 'no thanks'}
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="quiet"
          onClick={() => void window.lumen.invoke('helpers:coach-reset').then(reloadCoach)}
        >
          Forget tips and answers
        </Button>
      </Card>

      <Card
        title="Error rescue"
        description="When an error message pops up, Lumen offers to explain it. The message is only sent to the AI if you say yes."
      >
        <Switch
          checked={h.errorRescue}
          onChange={(errorRescue) => set({ errorRescue })}
          label="Offer help with error messages"
        />
      </Card>

      <Card
        title="What changed?"
        description="Ask “what changed?” or “did it work?” after a command to hear what is different in the window."
      >
        <Switch
          checked={h.whatChanged}
          onChange={(whatChanged) => set({ whatChanged })}
          label="Compare the screen before and after each command"
          hint="Each time you ask Lumen something, a small screenshot and the list of controls in the window are kept in memory. Nothing is saved or sent."
        />
      </Card>

      <Card
        title="Reading level"
        description="How Lumen explains things in answers, lessons and error help. Say “explain simpler”, “more technical” or add “here” for just this app."
      >
        <SegmentedControl
          label="Explanations"
          value={h.readingLevel}
          options={LEVELS}
          onChange={(readingLevel) => set({ readingLevel })}
        />
        {apps.length > 0 && (
          <ul className="panel-list" aria-label="Per app">
            {apps.map(([app, level]) => (
              <li key={app}>
                {app}: {LEVELS.find((l) => l.value === level)?.label}{' '}
                <Button
                  variant="quiet"
                  aria-label={`Use the general level in ${app}`}
                  onClick={() => {
                    const rest = { ...h.readingLevelApps }
                    delete rest[app]
                    set({ readingLevelApps: rest })
                  }}
                >
                  Reset
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Learning journal"
        description="A short note per day of the lessons you finished, shortcuts you picked up and questions you asked. Ask “what did I learn this week?”."
      >
        <Switch
          checked={h.journal}
          onChange={(journal) => set({ journal })}
          label="Keep a learning journal"
          hint="Stored on this PC in your .ai-overlay folder (journal)."
        />
        <Journal on={h.journal} />
      </Card>
    </>
  )
}
