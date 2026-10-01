// The guide on screen right now (step navigation by voice) and the last guide shown
// (save / replay).
import type { GuideStep, SavedGuide } from '@shared/types'
import { findGuideByName, loadSavedGuide, saveGuide } from './store'
import type { GuideNavCommand } from './voice-nav'
import { rectCenter } from '../actions/coords'
import { log } from '../logger'
import * as hud from '../windows/hud'
import * as highlight from '../windows/highlight'
import { setStatus } from '../windows/status'

interface ActiveGuide {
  steps: GuideStep[]
  index: number
}

let activeGuide: ActiveGuide | null = null
let lastGuide: { task: string; steps: GuideStep[]; savedAt: number } | null = null

/** Whether a guide is on screen, and whether one can be saved or replayed. */
export function guideState(): { guideActive: boolean; hasLastGuide: boolean } {
  return { guideActive: !!activeGuide, hasLastGuide: !!lastGuide }
}

export function startGuide(task: string, steps: GuideStep[]): void {
  activeGuide = { steps, index: 0 }
  lastGuide = { task, steps, savedAt: Date.now() }
}

/** Drops the active guide and clears its highlights. */
export function dismissGuide(): void {
  activeGuide = null
  highlight.clear()
}

export function saveLastAsGuide(name: string): SavedGuide | null {
  if (!lastGuide) return null
  const entry = saveGuide(lastGuide.task, lastGuide.steps, name)
  log('done', `saved guide "${entry.name}" as ${entry.id}`)
  return entry
}

// Re-run a saved guide by sending its task back through the normal query pipeline.
// Saved bboxes can drift as the UI changes — a fresh query re-computes them against
// whatever the user is looking at right now.
export function replaySavedGuide(id: string): SavedGuide | null {
  const entry = loadSavedGuide(id)
  if (!entry) return null
  log('step', `replaying saved guide "${entry.name}" (fresh query)`)
  setStatus('thinking', `Replaying: ${entry.name}`, { index: 2, total: 3 })
  hud.send('assistant:run-query', entry.task)
  return entry
}

function handleGuideNavCommand(cmd: GuideNavCommand): { handled: boolean; response?: unknown } {
  if (!activeGuide) return { handled: false }

  const showStep = (idx: number): void => {
    if (!activeGuide) return
    const clamped = Math.max(0, Math.min(activeGuide.steps.length - 1, idx))
    activeGuide.index = clamped
    const step = activeGuide.steps[clamped]
    const total = activeGuide.steps.length
    setStatus('step', step.label, { index: clamped + 1, total })
    if (step.bbox) {
      highlight.send('screen:highlights', [step])
      highlight.show()
      const c = rectCenter(step.bbox)
      highlight.send('screen:pointer', {
        x: Math.round(c.x),
        y: Math.round(c.y),
        text: `${clamped + 1}/${total}: ${step.label}`
      })
    }
  }

  if (cmd === 'done') {
    dismissGuide()
    setStatus('idle', 'Guide closed', undefined, 900)
    return { handled: true, response: { mode: 'answer', text: 'Guide closed.' } }
  }
  if (cmd === 'next') {
    if (activeGuide.index >= activeGuide.steps.length - 1) {
      setStatus('answer', 'Last step', undefined, 1400)
      return { handled: true, response: { mode: 'answer', text: 'You are on the last step.' } }
    }
    showStep(activeGuide.index + 1)
    return {
      handled: true,
      response: {
        mode: 'answer',
        text: `Step ${activeGuide.index + 1}: ${activeGuide.steps[activeGuide.index].label}`
      }
    }
  }
  if (cmd === 'prev') {
    showStep(Math.max(0, activeGuide.index - 1))
    return {
      handled: true,
      response: {
        mode: 'answer',
        text: `Step ${activeGuide.index + 1}: ${activeGuide.steps[activeGuide.index].label}`
      }
    }
  }
  if (cmd === 'repeat') {
    const step = activeGuide.steps[activeGuide.index]
    setStatus('step', step.label, { index: activeGuide.index + 1, total: activeGuide.steps.length })
    return {
      handled: true,
      response: { mode: 'answer', text: `Step ${activeGuide.index + 1}: ${step.label}` }
    }
  }
  return { handled: false }
}

export type GuideCommand =
  | { kind: 'guide-nav'; command: GuideNavCommand }
  | { kind: 'guide-play'; name: string }
  | { kind: 'guide-replay' }
  | { kind: 'guide-save'; name?: string }

/** Runs a guide command the router prefilter matched; undefined when it does not apply. */
export function handleGuideCommand(cmd: GuideCommand): unknown | undefined {
  if (cmd.kind === 'guide-nav') {
    const nav = handleGuideNavCommand(cmd.command)
    return nav.handled ? nav.response : undefined
  }

  if (cmd.kind === 'guide-play') {
    const found = findGuideByName(cmd.name)
    if (found) {
      replaySavedGuide(found.id)
      return {
        mode: 'answer',
        text: `Playing "${found.name}" (${found.steps.length} steps). Say "next" to advance.`
      }
    }
    return { mode: 'answer', text: `No saved guide matches "${cmd.name}".` }
  }

  if (!lastGuide) return undefined

  if (cmd.kind === 'guide-save') {
    const name = cmd.name ?? lastGuide.task
    const saved = saveLastAsGuide(name)
    if (!saved) return undefined
    return { mode: 'answer', text: `Saved as "${saved.name}". Say "play guide ${name}" to replay.` }
  }

  activeGuide = { steps: lastGuide.steps, index: 0 }
  setStatus('step', lastGuide.steps[0]?.label ?? 'Replaying guide', {
    index: 1,
    total: lastGuide.steps.length
  })
  highlight.send('screen:highlights', lastGuide.steps)
  highlight.show()
  return {
    mode: 'answer',
    text: `Replaying guide: "${lastGuide.task}" (${lastGuide.steps.length} steps). Say "next" to advance.`
  }
}
