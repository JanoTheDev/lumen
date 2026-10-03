// Settings → Accessibility → Moving: face gestures (11 T25). Download the face model once,
// turn the camera on, pick what each gesture does and calibrate: the wizard records the
// resting face, then each gesture held, and sets that gesture's threshold halfway between.
// Head pointer: head yaw / pitch move the pointer (joystick or absolute), with a live
// preview dot and a range step (centre, left, right, top, bottom) in the wizard.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FaceState } from '@shared/channels'
import { FACE_GESTURES, type FaceAction, type FaceConfig } from '@shared/config'
import {
  Button,
  Card,
  NumberField,
  ProgressBar,
  SegmentedControl,
  Select,
  Slider,
  Switch
} from '../../../ui'
import type { SectionProps } from '../meta'
import {
  calibrationPlan,
  FACE_ACTION_OPTIONS,
  FACE_GESTURE_LABEL,
  POINTER_GESTURES,
  previewDot,
  rangePlan,
  stepPrompt,
  type CalibrationStep
} from './face-view'
import { sameFaceState } from './face-state'

const POLL_MS = 300
/** Faster while the head pointer's preview dot shows. */
const POINTER_POLL_MS = 100
const PREVIEW_PX = 120
/** Time to get into position before each sample records. */
const GET_READY_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function useFaceState(active: boolean, fast = false): FaceState | null {
  const [state, setState] = useState<FaceState | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.lumen
        .invoke('face:state')
        .then((s) => alive && setState((prev) => (sameFaceState(prev, s) ? prev : s)))
        .catch(() => {})
    }
    load()
    if (!active) return () => (alive = false)
    // Polls skip while the window is hidden; showing it again reads at once.
    const tick = (): void => {
      if (!document.hidden) load()
    }
    const t = setInterval(tick, fast ? POINTER_POLL_MS : POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [active, fast])
  return state
}

function useCameras(): { deviceId: string; label: string }[] {
  const [cams, setCams] = useState<{ deviceId: string; label: string }[]>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    const load = (): void => {
      md?.enumerateDevices()
        .then((list) =>
          setCams(
            list
              .filter((d) => d.kind === 'videoinput' && d.deviceId)
              .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
          )
        )
        .catch(() => {})
    }
    load()
    md?.addEventListener('devicechange', load)
    return () => md?.removeEventListener('devicechange', load)
  }, [])
  return cams
}

function statusText(s: FaceState | null): string {
  if (!s) return ''
  if (!s.installed) return 'The face model is not downloaded yet.'
  switch (s.status) {
    case 'off':
      return 'Camera off.'
    case 'starting':
      return 'Starting the camera…'
    case 'error':
      return `Face gestures stopped: ${s.error ?? 'unknown error'}`
    case 'running':
      return s.frame?.face ? 'Camera on. I can see your face.' : 'Camera on. I cannot see a face.'
  }
}

function Wizard({ steps, onDone }: { steps: CalibrationStep[]; onDone: () => void }): JSX.Element {
  const [plan] = useState<CalibrationStep[]>(steps)
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<'ready' | 'recording' | 'result'>('ready')
  const [message, setMessage] = useState('')
  const [ok, setOk] = useState(false)
  const cancelled = useRef(false)
  const step = plan[index]

  useEffect(() => () => void (cancelled.current = true), [])

  const record = async (): Promise<void> => {
    setPhase('ready')
    setMessage('Get ready…')
    await sleep(GET_READY_MS)
    if (cancelled.current) return
    setPhase('recording')
    setMessage('Hold it…')
    const r = await window.lumen.invoke(
      'face:calibrate',
      step.kind === 'rest'
        ? { step: 'rest' }
        : step.kind === 'range'
          ? { step: 'range', at: step.at }
          : { step: 'gesture', gesture: step.gesture }
    )
    if (cancelled.current) return
    const good = !!r && 'ok' in r && r.ok
    setOk(good)
    setMessage(r && 'message' in r ? r.message : 'Calibration failed.')
    setPhase('result')
  }

  const next = (): void => {
    if (index + 1 >= plan.length) onDone()
    else {
      setIndex(index + 1)
      setPhase('ready')
      setMessage('')
      setOk(false)
    }
  }

  return (
    <div role="group" aria-label="Calibrate face gestures">
      <p>
        Step {index + 1} of {plan.length}: <strong>{stepPrompt(step)}</strong>
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <div className="panel-row">
        {phase !== 'recording' && (!ok || phase !== 'result') && (
          <Button variant="primary" onClick={() => void record()}>
            {phase === 'result' ? 'Try again' : 'Start'}
          </Button>
        )}
        {phase === 'result' && ok && (
          <Button variant="primary" onClick={next}>
            {index + 1 >= plan.length ? 'Finish' : 'Next'}
          </Button>
        )}
        {phase === 'result' && !ok && step.kind === 'gesture' && (
          <Button onClick={next}>Skip this gesture</Button>
        )}
        <Button onClick={onDone} disabled={phase === 'recording'}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function PointerPreview({ state }: { state: FaceState | null }): JSX.Element {
  const p = state?.pointer
  const box = PREVIEW_PX
  return (
    <div
      className="face-preview"
      role="img"
      aria-label={
        p
          ? `Head position ${Math.round(p.nx * 100)}% across, ${Math.round(p.ny * 100)}% down${p.paused ? ', paused' : ''}`
          : 'Head pointer not running'
      }
      style={{
        position: 'relative',
        width: box,
        height: box,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-sunken)'
      }}
    >
      {p && (
        <>
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: previewDot(-p.deadX, box),
              top: previewDot(-p.deadY, box),
              width: previewDot(p.deadX, box) - previewDot(-p.deadX, box),
              height: previewDot(p.deadY, box) - previewDot(-p.deadY, box),
              border: '1px dashed var(--border)',
              borderRadius: '50%'
            }}
          />
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: previewDot(p.nx, box) - 5,
              top: previewDot(p.ny, box) - 5,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: p.paused ? 'var(--fg-muted)' : 'var(--accent)'
            }}
          />
        </>
      )}
    </div>
  )
}

export function FaceGestures({ cfg, patch }: SectionProps): JSX.Element {
  const face = cfg.a11y.face
  const pointer = face.pointer
  const [wizard, setWizard] = useState<CalibrationStep[] | null>(null)
  const [installing, setInstalling] = useState(false)
  const [note, setNote] = useState('')
  const state = useFaceState(face.enabled || installing, face.enabled && pointer.enabled)
  const cameras = useCameras()
  const set = useCallback(
    (next: Partial<FaceConfig>) => void patch({ a11y: { face: { ...face, ...next } } }),
    [face, patch]
  )

  const setPointer = (next: Partial<FaceConfig['pointer']>): void =>
    set({ pointer: { ...pointer, ...next } })

  const install = (): void => {
    setInstalling(true)
    setNote('')
    window.lumen
      .invoke('face:install')
      .then((r) => setNote(r.ok ? 'Downloaded.' : `Download failed: ${r.error ?? 'unknown error'}`))
      .catch(() => setNote('Download failed.'))
      .finally(() => setInstalling(false))
  }

  const installed = !!state?.installed
  const running = state?.status === 'running'

  return (
    <Card
      title="Moving: face gestures"
      description="Use your face through the camera: open your mouth to click, raise your eyebrows to scroll, tilt your head to press your switch. Everything stays on this PC. Each camera frame is read and dropped, never saved or sent."
    >
      {!installed && (
        <div>
          <p>Face gestures need a face model and its engine, about 15 MB, downloaded once.</p>
          <Button variant="primary" busy={installing} disabled={installing} onClick={install}>
            Download face model
          </Button>
          {installing && state?.installing !== undefined && (
            <ProgressBar label="Downloading" value={state.installing / 100} />
          )}
        </div>
      )}
      {note && <p role="status">{note}</p>}
      <Switch
        checked={face.enabled}
        disabled={!installed}
        onChange={(enabled) => set({ enabled })}
        label="Use face gestures"
        hint="The camera is on only while this is on."
      />
      {face.enabled && (
        <p role="status" aria-live="polite">
          {statusText(state)}
        </p>
      )}
      <Select
        label="Camera"
        value={face.cameraId}
        options={[
          { value: '', label: 'System default' },
          ...cameras.map((c) => ({ value: c.deviceId, label: c.label }))
        ]}
        onChange={(cameraId) => set({ cameraId })}
      />
      <table className="panel-table">
        <thead>
          <tr>
            <th scope="col">Gesture</th>
            <th scope="col">Does</th>
            <th scope="col">Now</th>
          </tr>
        </thead>
        <tbody>
          {FACE_GESTURES.map((g) => {
            const level = state?.levels[g]
            return (
              <tr key={g}>
                <td>
                  {FACE_GESTURE_LABEL[g]}
                  {face.thresholds[g] ? '' : ' (not calibrated)'}
                  {pointer.enabled && POINTER_GESTURES.includes(g)
                    ? ' (off: moves the head pointer)'
                    : ''}
                </td>
                <td>
                  <Select<FaceAction>
                    label={`${FACE_GESTURE_LABEL[g]} does`}
                    value={face.bindings[g]}
                    options={FACE_ACTION_OPTIONS}
                    onChange={(action) => set({ bindings: { ...face.bindings, [g]: action } })}
                  />
                </td>
                <td>
                  {running && level !== undefined
                    ? level >= 1
                      ? 'Detected'
                      : `${Math.round(level * 100)}%`
                    : '–'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <NumberField
        label="Hold time"
        value={face.holdMs}
        min={50}
        max={3000}
        step={50}
        unit="ms"
        hint="How long to hold a gesture before it acts."
        onCommit={(holdMs) => set({ holdMs })}
      />
      <NumberField
        label="Pause after a gesture"
        value={face.cooldownMs}
        min={100}
        max={10000}
        step={100}
        unit="ms"
        onCommit={(cooldownMs) => set({ cooldownMs })}
      />
      <Switch
        checked={pointer.enabled}
        disabled={!installed}
        onChange={(enabled) => setPointer({ enabled })}
        label="Move the pointer with my head"
        hint="Turn or nod your head to move the mouse pointer. Click with dwell or a face gesture. Say “recentre” to set the centre, “pause the head pointer” to stop it."
      />
      {pointer.enabled && (
        <>
          <SegmentedControl<FaceConfig['pointer']['mode']>
            label="Pointer mode"
            value={pointer.mode}
            options={[
              { value: 'relative', label: 'Joystick' },
              { value: 'absolute', label: 'Point at the screen' }
            ]}
            onChange={(mode) => setPointer({ mode })}
            hint="Joystick: the further you turn, the faster it moves. Point at the screen: where you look is where it goes."
          />
          {pointer.mode === 'relative' && (
            <>
              <Slider
                label="Speed"
                value={pointer.speed}
                min={1}
                max={10}
                step={0.5}
                onChange={(speed) => setPointer({ speed })}
              />
              <Slider
                label="Dead zone"
                value={pointer.deadZone}
                min={0}
                max={15}
                step={0.5}
                format={(v) => `${v}°`}
                hint="How far you can move your head before the pointer moves."
                onChange={(deadZone) => setPointer({ deadZone })}
              />
              <Slider
                label="Acceleration"
                value={pointer.acceleration}
                min={1}
                max={3}
                step={0.1}
                hint="Higher: slow and precise near the centre, fast at the edge."
                onChange={(acceleration) => setPointer({ acceleration })}
              />
            </>
          )}
          <Slider
            label="Smoothing"
            value={pointer.smoothing}
            min={0}
            max={0.9}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(smoothing) => setPointer({ smoothing })}
          />
          <PointerPreview state={running ? state : null} />
          <p>
            {pointer.range
              ? 'Pointer range calibrated.'
              : 'Pointer range not calibrated: the centre is where you look when the camera starts.'}
          </p>
        </>
      )}
      {wizard ? (
        <Wizard steps={wizard} onDone={() => setWizard(null)} />
      ) : (
        <div className="panel-row">
          <Button disabled={!running} onClick={() => setWizard(calibrationPlan(face))}>
            Calibrate
          </Button>
          {pointer.enabled && (
            <Button disabled={!running} onClick={() => setWizard(rangePlan())}>
              Calibrate pointer range
            </Button>
          )}
          {pointer.enabled && (
            <Button disabled={!pointer.range} onClick={() => setPointer({ range: null })}>
              Reset pointer range
            </Button>
          )}
          <Button
            disabled={!Object.values(face.thresholds).some(Boolean)}
            onClick={() =>
              set({
                thresholds: Object.fromEntries(FACE_GESTURES.map((g) => [g, null]))
              })
            }
          >
            Reset calibration
          </Button>
        </div>
      )}
    </Card>
  )
}
