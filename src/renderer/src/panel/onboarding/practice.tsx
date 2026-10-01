// Practice steps (surfaces.md §6, steps 5–6): a small board of buttons inside the setup
// window. "Watch me point" asks the real pipeline where a button is, so the screen layer
// points at it; "Show numbers" uses the voice commands to click one by number.
import { useState } from 'react'
import { Button, Kbd, announce, icons } from '../../ui'
import { send } from '../../lib/ipc'
import type { Config, Patch } from '../settings/useConfig'
import { talkHint } from './flow'

export const PRACTICE_BUTTONS = [
  { id: 'blue', label: 'Send', color: 'Blue' },
  { id: 'green', label: 'Save', color: 'Green' },
  { id: 'red', label: 'Delete', color: 'Red' },
  { id: 'grey', label: 'Cancel', color: 'Grey' }
] as const

function Board(): JSX.Element {
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
