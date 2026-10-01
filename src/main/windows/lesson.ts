// Lesson output (07 T15): draws the lesson's ScreenScene on the screen layer and its state in
// the assistant bar. The lesson engine only publishes on the bus; this is the one subscriber.
// The do-it offer is a bar confirm; its answer goes back as a lesson command.
import type { AssistantState, ScreenScene } from '@shared/events'
import { bus } from '../bus'
import * as assistant from './assistant'
import * as highlight from './highlight'
import * as screenLayer from './screen-layer'
import { hideStatus, setStatus } from './status'
import { uiV2 } from './ui-mode'

type Scene = Omit<ScreenScene, 'monitorId'>

/** The resume offer stays this long (it is passive; nothing starts by itself). */
const RESUME_OFFER_MS = 15_000

let confirmSeq = 0
let drew = false

function drawV2(scene: Scene | null): void {
  if (!scene) {
    if (drew) screenLayer.setScene({ highlights: [], buddy: undefined, annotations: undefined })
    drew = false
    return
  }
  drew = true
  screenLayer.setScene({
    highlights: scene.highlights,
    buddy: scene.buddy,
    annotations: scene.annotations
  })
}

/** v1 windows: ring/target highlights and the pointer bubble. */
function drawV1(scene: Scene | null): void {
  if (!scene || (!scene.highlights.length && !scene.buddy)) {
    if (drew) highlight.clear()
    drew = false
    return
  }
  drew = true
  highlight.send(
    'screen:highlights',
    scene.highlights.map((h) => ({ label: h.label ?? '', target_hint: '', bbox: h.rect }))
  )
  if (scene.buddy)
    highlight.send('screen:pointer', { ...scene.buddy.to, text: scene.buddy.label ?? '' })
  highlight.show()
}

function showState(state: AssistantState | null): void {
  // A newer state replaces an open do-it offer; its late answer is ignored.
  const seq = ++confirmSeq
  if (!state) {
    hideStatus()
    return
  }
  if (state.confirm && uiV2()) {
    void assistant
      .requestConfirm({
        summary: state.statusText ?? state.confirm.summary,
        risk: state.confirm.risk
      })
      .then((ok) => {
        if (seq === confirmSeq) bus.emit({ type: 'lesson.command', command: ok ? 'yes' : 'no' })
      })
    return
  }
  if (uiV2() && assistant.state().confirm) assistant.close()
  const kind = state.phase === 'acting' ? 'acting' : state.phase === 'idle' ? 'answer' : 'step'
  setStatus(kind, state.statusText ?? '', state.step, kind === 'answer' ? 4000 : undefined)
}

export function installLessonOutput(): void {
  bus.on('lesson.scene', (e) => (uiV2() ? drawV2(e.scene) : drawV1(e.scene)))
  bus.on('lesson.state', (e) => showState(e.state))
  bus.on('lesson.resume-offer', (e) => setStatus('answer', e.text, undefined, RESUME_OFFER_MS))
}
