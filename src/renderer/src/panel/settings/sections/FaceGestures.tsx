// Settings → Accessibility → Moving: face gestures (11 T25). Download the face model once,
// turn the camera on, pick what each gesture does and calibrate: the wizard records the
// resting face, then each gesture held, and sets that gesture's threshold halfway between.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FaceState } from '@shared/channels'
import { FACE_GESTURES, type FaceAction, type FaceConfig } from '@shared/config'
import { Button, Card, NumberField, ProgressBar, Select, Switch } from '../../../ui'
import type { SectionProps } from '../meta'
import {
  calibrationPlan,
  FACE_ACTION_OPTIONS,
  FACE_GESTURE_LABEL,
  stepPrompt,
  type CalibrationStep
} from './face-view'

const POLL_MS = 300
/** Time to get into position before each sample records. */
const GET_READY_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function useFaceState(active: boolean): FaceState | null {
  const [state, setState] = useState<FaceState | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.lumen
        .invoke('face:state')
        .then((s) => alive && setState(s))
        .catch(() => {})
    }
    load()
    if (!active) return () => (alive = false)
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [active])
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

function Wizard({ face, onDone }: { face: FaceConfig; onDone: () => void }): JSX.Element {
  const [plan] = useState<CalibrationStep[]>(() => calibrationPlan(face))
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
      step.kind === 'rest' ? { step: 'rest' } : { step: 'gesture', gesture: step.gesture }
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

export function FaceGestures({ cfg, patch }: SectionProps): JSX.Element {
  const face = cfg.a11y.face
  const [wizard, setWizard] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [note, setNote] = useState('')
  const state = useFaceState(face.enabled || installing)
  const cameras = useCameras()
  const set = useCallback(
    (next: Partial<FaceConfig>) => void patch({ a11y: { face: { ...face, ...next } } }),
    [face, patch]
  )

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
      {wizard ? (
        <Wizard face={face} onDone={() => setWizard(false)} />
      ) : (
        <div className="panel-row">
          <Button disabled={!running} onClick={() => setWizard(true)}>
            Calibrate
          </Button>
          <Button
            disabled={!Object.keys(face.thresholds).length}
            onClick={() => set({ thresholds: {} })}
          >
            Reset calibration
          </Button>
        </div>
      )}
    </Card>
  )
}
