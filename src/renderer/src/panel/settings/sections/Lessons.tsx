// Lessons (07 T22, T27-T33): the lesson picker. Progress per app (mastery, next lesson),
// due reviews, your own lessons, every app's lessons as a skill tree (units, done / up next /
// locked), saving the last lesson, recording your steps, community packs, and the review
// reminder and opt-in idle hint settings.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LessonListItem, LessonProgressView } from '@shared/channels'
import {
  Button,
  Card,
  IconButton,
  NumberField,
  ProgressBar,
  Switch,
  announce,
  icons
} from '../../../ui'
import type { SectionProps } from '../meta'
import { Challenges } from './Challenges'
import { CommunityPacks } from './CommunityPacks'
import { Handoff } from './Handoff'
import { LessonImport } from './LessonImport'
import { RecordSteps } from './RecordSteps'

function play(id: string): void {
  window.lumen.invoke('teach:start', id).catch(() => {})
  window.lumen.send('settings:window-minimize')
}

function review(id: string): void {
  window.lumen.invoke('teach:review', id).catch(() => {})
  window.lumen.send('settings:window-minimize')
}

const STATUS_TEXT: Record<NonNullable<LessonListItem['status']>, string> = {
  done: 'done',
  next: 'up next',
  open: '',
  locked: 'locked'
}

function meta(l: LessonListItem): string {
  const steps = `${l.steps} ${l.steps === 1 ? 'step' : 'steps'}`
  const parts = [l.level, `about ${l.minutes} min`, steps]
  if (l.completed) parts.push(`done ${l.completed}×`)
  else if (l.status && STATUS_TEXT[l.status]) parts.push(STATUS_TEXT[l.status])
  if (l.reviewDue) parts.push('review due')
  if (l.community) parts.push('community pack')
  if (l.needs?.length) parts.push(`first: ${l.needs.join(', ')}`)
  return parts.join(' · ')
}

/** Lessons grouped by curriculum unit, in order; lessons outside a unit last. */
function byUnit(list: LessonListItem[]): [string, LessonListItem[]][] {
  const groups = new Map<string, LessonListItem[]>()
  for (const l of list) {
    const key = l.unit?.title ?? 'More lessons'
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  return [...groups.entries()]
}

function LessonRow({ l }: { l: LessonListItem }): JSX.Element {
  return (
    <li className="panel-list__item">
      <div className="panel-list__text">
        <span className="panel-list__title">{l.title}</span>
        <span className="ui-hint">{meta(l)}</span>
      </div>
      {l.reviewDue && (
        <IconButton icon={icons.repeat} label={`Review ${l.title}`} onClick={() => review(l.id)} />
      )}
      <IconButton icon={icons.play} label={`Play ${l.title}`} onClick={() => play(l.id)} />
    </li>
  )
}

export function Lessons({ cfg, patch }: SectionProps): JSX.Element {
  const [lessons, setLessons] = useState<LessonListItem[]>([])
  const [progress, setProgress] = useState<LessonProgressView | null>(null)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  // Bumped when a tutorial import makes a draft, so Record my steps shows it.
  const [draftKey, setDraftKey] = useState(0)

  const refresh = useCallback(() => {
    window.lumen
      .invoke('teach:list')
      .then(setLessons)
      .catch(() => {})
    window.lumen
      .invoke('teach:progress')
      .then(setProgress)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const mine = lessons.filter((l) => l.source === 'user')
  const byApp = useMemo(() => {
    const groups = new Map<string, LessonListItem[]>()
    for (const l of lessons) {
      if (l.source !== 'pack') continue
      groups.set(l.appName, [...(groups.get(l.appName) ?? []), l])
    }
    return [...groups.entries()]
  }, [lessons])
  const started = (progress?.apps ?? []).filter((a) => a.completed > 0)
  const apps = progress?.apps ?? []
  const t = cfg.teach

  const save = async (): Promise<void> => {
    const res = await window.lumen.invoke('teach:save-last', name.trim())
    const text = 'error' in res ? res.error : `Saved “${res.title}”`
    setMsg(text)
    announce(text, 'error' in res ? 'assertive' : 'polite')
    if (!('error' in res)) {
      setName('')
      refresh()
    }
  }

  const toggleIdleApp = (appId: string, on: boolean): void => {
    // Empty = every app; the first app switched off lists all the others.
    const all = apps.map((a) => a.appId)
    const current = t.idleHintApps.length ? t.idleHintApps : all
    const next = on ? [...new Set([...current, appId])] : current.filter((x) => x !== appId)
    patch({ teach: { idleHintApps: next.length === all.length ? [] : next } })
  }
  const idleOn = (appId: string): boolean =>
    !t.idleHintApps.length || t.idleHintApps.includes(appId)

  return (
    <>
      <Card
        title="Your progress"
        description={
          started.length
            ? 'Mastery grows each time you finish a lesson or a review with fewer hints. Say “what should I learn next” for a suggestion.'
            : 'Finish a lesson to see your progress here.'
        }
      >
        {started.map((a) => (
          <div key={a.appId} className="panel-row">
            <ProgressBar
              label={`${a.appName}: ${a.completed} of ${a.total} lessons`}
              value={a.mastery}
              valueText={`${Math.round(a.mastery * 100)}% mastery`}
            />
            {a.next && <Button onClick={() => play(a.next!.lessonId)}>Next: {a.next.title}</Button>}
          </div>
        ))}
      </Card>

      {!!progress?.reviews.length && (
        <Card
          title="Reviews due"
          description="A short check that you still remember: the same steps, with less help. Each review comes back later, further apart when it goes well."
        >
          <ul className="panel-list">
            {progress.reviews.map((r) => (
              <li key={r.lessonId} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">{r.title}</span>
                  <span className="ui-hint">
                    {r.appName} · due {r.due}
                  </span>
                </div>
                <IconButton
                  icon={icons.repeat}
                  label={`Review ${r.title}`}
                  onClick={() => review(r.lessonId)}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Save the last lesson"
        description="Ask “show me how …” and Lumen makes a lesson on the spot. Save it here to play it again, or say “save this lesson”."
      >
        <div className="panel-row panel-row--end">
          <div className="ui-field">
            <label htmlFor="lesson-name" className="ui-field__label">
              Name
            </label>
            <input
              id="lesson-name"
              className="ui-input"
              value={name}
              placeholder="Change display scaling"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </div>
          <Button variant="primary" onClick={save}>
            Save lesson
          </Button>
        </div>
        {msg && <p className="ui-hint">{msg}</p>}
      </Card>

      <LessonImport apps={apps} onDraft={() => setDraftKey((k) => k + 1)} />

      <RecordSteps key={draftKey} onSaved={refresh} />

      <Card
        title="Your lessons"
        description={
          mine.length
            ? `${mine.length} saved, including your old saved guides. Say “start lesson” and a name to play one.`
            : 'Nothing saved yet.'
        }
      >
        {mine.length > 0 && (
          <ul className="panel-list">
            {mine.map((l) => (
              <li key={l.id} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">{l.title}</span>
                  <span className="ui-hint">
                    {l.appName} · {meta(l)}
                  </span>
                </div>
                <IconButton
                  icon={icons.play}
                  label={`Play ${l.title}`}
                  onClick={() => play(l.id)}
                />
                <IconButton
                  icon={icons.trash}
                  label={`Delete ${l.title}`}
                  variant="danger"
                  onClick={async () => {
                    await window.lumen.invoke('teach:delete', l.id)
                    announce(`Deleted ${l.title}`)
                    refresh()
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Lessons by app"
        description="Step-by-step lessons that watch what you do, in the order to learn them. A locked lesson can still be played. Say “teach me” and an app name to hear its list."
      >
        {byApp.map(([app, list]) => (
          <details key={app} className="panel-details">
            <summary>
              {app} ({list.filter((l) => l.completed).length} of {list.length} done)
            </summary>
            {byUnit(list).map(([unit, items]) => (
              <section key={unit} aria-label={unit}>
                <h3 className="ui-hint">{unit}</h3>
                <ul className="panel-list">
                  {items.map((l) => (
                    <LessonRow key={l.id} l={l} />
                  ))}
                </ul>
              </section>
            ))}
          </details>
        ))}
      </Card>

      <CommunityPacks apps={apps} onChanged={refresh} />

      <Challenges apps={apps} />

      <Handoff mine={mine} onChanged={refresh} />

      <Card title="Learning help">
        <Switch
          checked={t.reviewReminders}
          onChange={(reviewReminders) => patch({ teach: { reviewReminders } })}
          label="Remind me about reviews"
          hint="When you open an app with a review due, a short note shows in the bar. At most once a day. Say “stop reminding me” to turn this off."
        />
        <Switch
          checked={t.idleHint}
          onChange={(idleHint) => patch({ teach: { idleHint } })}
          label="Idle hints"
          hint="Off by default. During a lesson, or in coach mode (say “coach mode on”), a hint shows after you stop for a while. Only your idle time and the window in front are checked, on this PC. No screenshots outside a lesson."
        />
        {t.idleHint && (
          <>
            <NumberField
              label="Wait before a hint"
              value={t.idleHintSec}
              min={5}
              max={300}
              unit="seconds"
              onCommit={(idleHintSec) => patch({ teach: { idleHintSec } })}
            />
            <Switch
              checked={t.idleHintVoice}
              onChange={(idleHintVoice) => patch({ teach: { idleHintVoice } })}
              label="Speak idle hints"
              hint="Off: the hint shows in the bar only."
            />
            <fieldset className="panel-fieldset">
              <legend className="ui-field__label">Apps with idle hints</legend>
              {apps.map((a) => (
                <Switch
                  key={a.appId}
                  checked={idleOn(a.appId)}
                  onChange={(on) => toggleIdleApp(a.appId, on)}
                  label={a.appName}
                />
              ))}
            </fieldset>
          </>
        )}
      </Card>
    </>
  )
}
