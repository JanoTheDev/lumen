// src/main/task-planner.ts
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { getModel, getProvider } from './model-router'
import { log } from './logger'
import { hashScreenshot, shouldVerifyStep, verifyStep } from './step-verifier'
import { type ClaudeResponse, type Action } from './claude'

export interface PlanStep {
  index: number
  description: string
}

export interface ExecutionPlan {
  task: string
  steps: PlanStep[]
}

export interface PlanProgress {
  stepIndex: number
  totalSteps: number | null
  description: string
  status: 'running' | 'done' | 'failed'
}

type ProgressCallback = (p: PlanProgress) => void
type ScreenshotFn = () => Promise<string>
type ExecuteActionFn = (actions: Action[]) => Promise<void>
type QueryAIFn = (prompt: string, screenshot: string | null, activeWindow: string) => Promise<ClaudeResponse>

const MAX_RETRIES = 3

export async function buildPlan(
  prompt: string,
  screenshot: string | null,
  activeWindow: string
): Promise<ExecutionPlan> {
  const provider = getProvider()
  const model = getModel('planning')
  const start = Date.now()

  const planPrompt = `User wants to: "${prompt}"
Current app: ${activeWindow}
List the steps to accomplish this as JSON: {"task":"<brief title>","steps":[{"index":1,"description":"<what to do>"},...]}
Each step should be one discrete action. Max 8 steps. Return ONLY the JSON.`

  let raw = ''

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const content: Anthropic.MessageParam['content'] = []
    if (screenshot) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } })
    }
    content.push({ type: 'text', text: planPrompt })
    const msg = await client.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content }]
    })
    raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
  } else {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] = []
    if (screenshot) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'low' } })
    }
    userContent.push({ type: 'text', text: planPrompt })
    const resp = await client.chat.completions.create({
      model,
      max_completion_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: userContent }]
    })
    raw = resp.choices[0]?.message?.content ?? ''
  }

  try {
    const plan = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()) as ExecutionPlan
    log('plan', `task: "${plan.task}"`)
    log('plan', `steps: ${plan.steps.length} | model: ${model}`, { timeMs: Date.now() - start })
    return plan
  } catch {
    return { task: prompt, steps: [{ index: 1, description: prompt }] }
  }
}

export async function executePlan(
  plan: ExecutionPlan,
  activeWindow: string,
  queryAI: QueryAIFn,
  takeScreenshot: ScreenshotFn,
  executeActions: ExecuteActionFn,
  onProgress: ProgressCallback
): Promise<ClaudeResponse> {
  let lastResult: ClaudeResponse = { mode: 'answer', text: 'Done' }
  const totalSteps = plan.steps.length

  for (const step of plan.steps) {
    log('step', `${step.index}/${totalSteps} ${step.description}`)
    onProgress({ stepIndex: step.index, totalSteps, description: step.description, status: 'running' })

    let retries = 0
    let succeeded = false

    while (retries < MAX_RETRIES && !succeeded) {
      const screenshot = await takeScreenshot()
      const beforeHash = hashScreenshot(screenshot)

      const result = await queryAI(step.description, screenshot, activeWindow)
      lastResult = result

      if (result.mode === 'action' && result.actions?.length) {
        const firstActionType = result.actions[0].type
        await executeActions(result.actions)

        if (shouldVerifyStep(firstActionType)) {
          const afterScreenshot = await takeScreenshot()
          const { success, detail } = await verifyStep(step.description, afterScreenshot, beforeHash)

          if (!success) {
            retries++
            log('retry', `${retries}/${MAX_RETRIES} — ${detail}`)
            if (retries >= MAX_RETRIES) {
              log('fail', `step ${step.index} failed after ${MAX_RETRIES} retries: ${detail}`)
              break
            }
            continue
          }
        }
      }

      succeeded = true
    }

    onProgress({ stepIndex: step.index, totalSteps, description: step.description, status: succeeded ? 'done' : 'failed' })
    if (!succeeded) break
  }

  log('done', `${plan.steps.length}/${plan.steps.length} steps complete`)
  return lastResult
}
