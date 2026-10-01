// Practice steps (surfaces.md §6, steps 5–7): a small board of buttons inside the setup
// window. "Watch me point" asks the real pipeline where a button is, so the screen layer
// points at it; "Show numbers" uses the voice commands to click one by number; the mini
// lesson (07) runs a three-step lesson on the board.
import { useEffect, useRef, useState } from 'react'
import { Button, Kbd, announce, icons } from '../../ui'
import { invoke, send } from '../../lib/ipc'
import type { Config, Patch } from '../settings/useConfig'
import { talkHint } from './flow'

export const PRACTICE_BUTTONS = [
  { id: 'blue', label: 'Send', color: 'Blue' },
  { id: 'green', label: 'Save', color: 'Green' },
  { id: 'red', label: 'Delete', color: 'Red' },
  { id: 'grey', label: 'Cancel', color: 'Grey' }
] as const

/** The onboarding mini lesson's id (main: teach/practice-lesson.ts). */
const PRACTICE_LESSON_ID = 'lumen-practice'

function Board({ onPick }: { onPick?: (label: string) => void } = {}): JSX.Element {
  const [clicked, setClicked] = useState<string | null>(null)
  return (
    <div className="ob-practice">
      <div className="ob-practice__board" role="group" aria-label="Practice buttons">
        {PRACTICE_BUTTONS.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`ob-practice__btn is-${b.id}`}
            onClick={() => {
              const msg = `You clicked the ${b.color.toLowerCase()} ${b.label} button`
              setClicked(msg)
              announce(msg)
              onPick?.(b.label)
            }}
          >
            {b.label}
          </button>
        ))}
      </div>
      <p className="ob-practice__result" aria-hidden="true">
        {clicked ? (
          <>
            <icons.check /> {clicked}
          </>
        ) : (
          'Nothing clicked yet'
        )}
      </p>
    </div>
  )
}

function hintFor(cfg: Config): string {
  return talkHint({
    hotkey: cfg.hotkey,
    tap: cfg.handsFreeMode,
    wake: cfg.wakeWord.enabled ? cfg.wakeWord.phrase : null
  })
}

export function PointStep({ cfg }: { cfg: Config }): JSX.Element {
  const question = 'Where is the blue button?'
  return (
    <div className="ob-stack">
      <p className="ob-lead">
        {hintFor(cfg)}: “{question}” Lumen finds it on your screen and points at it.
      </p>
      <div className="ob-hotkey" aria-hidden="true">
        <Kbd combo={cfg.hotkey} />
      </div>
      <Board />
      <div className="panel-row">
        <Button icon={icons.play} onClick={() => send('home:run', question)}>
          Ask for me
        </Button>
      </div>
    </div>
  )
}

export function LessonStep({ cfg }: { cfg: Config }): JSX.Element {
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)

  // Leaving the step ends the mini lesson if it is still running.
  useEffect(
    () => () => {
      if (!startedRef.current) return
      void invoke('teach:progress')
        .then((p) => {
          if (p.active?.running && p.active.lessonId === PRACTICE_LESSON_ID)
            void invoke('teach:command', 'stop')
        })
        .catch(() => {})
    },
    []
  )

  const start = (): void => {
    startedRef.current = true
    setStarted(true)
    void invoke('teach:start', PRACTICE_LESSON_ID).catch(() => {})
  }

  return (
    <div className="ob-stack">
      <p className="ob-lead">
        Lumen can teach you an app step by step. In this one-minute lesson Lumen points at a button,
        you click it, and it moves on by itself once you have.
      </p>
      <div className="panel-row">
        <Button variant="primary" icon={icons.play} onClick={start}>
          {started ? 'Start again' : 'Start the mini lesson'}
        </Button>
      </div>
      <Board onPick={(label) => send('teach:practice', label)} />
      <p className="ui-hint">
        While it runs, say “help”, “repeat” or “click it”, or {hintFor(cfg).toLowerCase()}: “how do
        I …” to get a lesson for anything. Say “stop lesson” to end it.
      </p>
    </div>
  )
}

export function NumbersStep({ cfg, patch }: { cfg: Config; patch: Patch }): JSX.Element {
  const on = cfg.a11y.voiceCommands
  return (
    <div className="ob-stack">
      <p className="ob-lead">
        {hintFor(cfg)}: “show numbers”. Every button gets a number. Then say “click” and the number
        of the blue Send button.
      </p>
      {!on && (
        <div className="panel-row">
          <p className="ui-hint">Voice commands are off.</p>
          <Button onClick={() => void patch({ a11y: { voiceCommands: true } })}>
            Turn on voice commands
          </Button>
        </div>
      )}
      <Board />
      <p className="ui-hint">Say “hide numbers” to take them away again.</p>
    </div>
  )
}
