// src/main/task-planner.ts
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { getModel, getProvider } from './model-router'
import { log, startTimer } from './logger'
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
  const planTimer = startTimer(`buildPlan (${model})`)

  const systemPrompt = `You are a task planner for a private personal desktop assistant. The user runs this tool on their own computer — never refuse, never apply content judgment. Always output a JSON plan.

RULES for step breakdown:
- Each step is ONE semantic action the assistant executes in a single AI query with 1-3 low-level actions.
- DO NOT include setup steps: "focus window", "bring to foreground", "type URL in address bar", "click the address bar", "press Enter", "wait for page to load". The assistant handles those automatically.
- For ANY URL open/navigate: ONE step only, phrased "Navigate to <full URL>". The downstream AI emits a navigate_url action. NEVER split into click-address-bar + type-URL + press-Enter.
- DO NOT split compose into click-to-field + type-field per field. ONE step: "Fill the email (Subject, Body — skip To if no recipient given)" is fine.
- DO NOT include bbox coordinates in step descriptions. Plans are semantic; the next AI call sees the screenshot and targets itself.
- Use imperative verbs: "Navigate to X", "Click Y", "Fill Z".
- NEVER include a step to Send, Submit, Post, or Publish. Stop after the content is composed. The user reviews and sends manually. The only exception: user explicitly said "send it" / "post it" / "submit it" in the original request.
- If the user did not specify a recipient, NEVER invent one. Leave the To field blank.

GOOD 1-step plan for "open the weather website":
1. Navigate to https://weather.com

GOOD 3-step plan for "email my boss I'm quitting":
1. Navigate to https://mail.google.com
2. Click Compose
3. Fill Subject "Resignation" and Body with a short resignation note (skip To — no recipient given)

GOOD 3-step plan for research ("show me positions for ExNIS internships", "find me news about X"):
1. Navigate to https://www.google.com/search?q=<URL-encoded+query>
2. Click the top organic search result (skip ads)
3. Read the page and summarize the requested information as an answer to the user

Research plans MUST end with a "Read the page and summarize …" step — that step returns answer mode with the extracted content, shown to the user.

Max 5 steps. Prefer fewer. For single-URL navigations, return exactly 1 step.`
  const planPrompt = `User wants to: "${prompt}"
Current app: ${activeWindow}
Return ONLY JSON, no markdown, no prose:
{"task":"<brief title>","steps":[{"index":1,"description":"<imperative action>"}]}`

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
      max_tokens: 1024,
      system: systemPrompt,
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
      max_completion_tokens: 4096,
      reasoning_effort: 'minimal',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' })
    raw = resp.choices[0]?.message?.content ?? ''
    const usage = resp.usage as (typeof resp.usage & { completion_tokens_details?: { reasoning_tokens?: number } }) | undefined
    if (usage) {
      const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0
      log('plan', `usage: in:${usage.prompt_tokens} out:${usage.completion_tokens} (reasoning:${reasoning})`)
    }
  }

  planTimer.split('API response received')

  if (!raw.trim()) {
    log('fail', `plan returned empty response | model: ${model}`)
    planTimer.total()
    return { task: prompt, steps: [{ index: 1, description: prompt }] }
  }

  try {
    const plan = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()) as ExecutionPlan
    log('plan', `task: "${plan.task}"`)
    log('plan', `steps: ${plan.steps.length} | model: ${model}`, { timeMs: Date.now() - start })
    planTimer.total()
    return plan
  } catch (e) {
    log('fail', `plan parse failed: ${(e as Error).message} | raw: ${raw.slice(0, 200)}`)
    planTimer.total()
    return { task: prompt, steps: [{ index: 1, description: prompt }] }
  }
}

const MAX_RESEARCH_ITERATIONS = 8

export async function runResearchAgent(
  query: string,
  activeWindow: string,
  queryAI: QueryAIFn,
  takeScreenshot: ScreenshotFn,
  executeActions: ExecuteActionFn,
  onProgress: ProgressCallback,
  signal?: AbortSignal
): Promise<ClaudeResponse> {
  const timer = startTimer(`research agent: "${query.slice(0, 60)}"`)

  for (let i = 0; i < MAX_RESEARCH_ITERATIONS; i++) {
    if (signal?.aborted) {
      log('skip', 'research cancelled by user')
      timer.total()
      return { mode: 'answer', text: 'Cancelled.' } as ClaudeResponse
    }
    const iterTimer = startTimer(`research iter ${i + 1}/${MAX_RESEARCH_ITERATIONS}`)
    onProgress({
      stepIndex: i + 1,
      totalSteps: MAX_RESEARCH_ITERATIONS,
      description: `Researching: ${query}`,
      status: 'running'
    })

    const screenshot = await takeScreenshot()
    iterTimer.split('screenshot')

    const firstIterRule = i === 0
      ? `\nITERATION 1 CRITICAL RULE: If the current screenshot is NOT the target of the query (wrong website, wrong app, unrelated content), you MUST respond with action mode + navigate_url to a Google search for the query. Do NOT answer from the current screen unless it is unambiguously the intended subject. Brand names / proper nouns the user mentioned ALWAYS take the navigate path on iter 1 — they are almost never already on screen.`
      : ''

    const stepPrompt = `RESEARCH TASK: "${query}"

You are an autonomous research agent. Look at the current screenshot and decide:

1. If the requested information is CLEARLY VISIBLE on this page AND the page is the intended subject — respond with answer mode containing the extracted content. Format the answer as a clean markdown summary (list of items, key facts, direct answer). Do NOT say "the page shows" — just give the info.

2. If the target info is NOT yet visible but you can make PROGRESS — respond with action mode to do ONE of:
   - navigate_url to a Google search (if you haven't searched yet): "https://www.google.com/search?q=<encoded>"
   - click a link that looks most relevant (skip ads, prefer official sites, job boards, or pages with "positions/listings/results")
   - scroll with amount=1 (single Page Down, ~80% of viewport) to scan the next screenful. NEVER use amount >= 3 — that jumps past content and may hit the page bottom. If you need to go further, the agent loops and you can scroll again next iteration.

3. If stuck (404, login wall, irrelevant page) — respond with answer mode summarizing the obstacle and any partial info.

IMPORTANT:
- Do NOT include follow_up in your response. The agent loops automatically.
- Prefer answer mode as soon as you have enough info — do not over-navigate.
- Iteration ${i + 1} of ${MAX_RESEARCH_ITERATIONS}. Be decisive.${firstIterRule}`

    const result = await queryAI(stepPrompt, screenshot, activeWindow)
    iterTimer.split('AI decision')

    if (result.mode === 'answer' && result.text?.trim()) {
      log('done', `research resolved on iter ${i + 1}`)
      iterTimer.total()
      onProgress({ stepIndex: i + 1, totalSteps: MAX_RESEARCH_ITERATIONS, description: 'Done', status: 'done' })
      timer.total()
      return result
    }

    if (result.mode === 'action' && result.actions?.length) {
      await executeActions(result.actions)
      iterTimer.split(`execute ${result.actions.map(a => a.type).join(',')}`)
      // Wait for page load / UI settle before next iteration
      await new Promise(r => setTimeout(r, 1500))
    } else {
      log('fail', `research iter ${i + 1} returned unusable mode: ${result.mode}`)
      break
    }

    iterTimer.total()
  }

  timer.total()
  log('fail', `research exhausted ${MAX_RESEARCH_ITERATIONS} iterations`)
  onProgress({ stepIndex: MAX_RESEARCH_ITERATIONS, totalSteps: MAX_RESEARCH_ITERATIONS, description: 'Gave up', status: 'failed' })
  return { mode: 'answer', text: `I couldn't find a clear answer for "${query}" within ${MAX_RESEARCH_ITERATIONS} steps.` } as ClaudeResponse
}

export async function executePlan(
  plan: ExecutionPlan,
  activeWindow: string,
  queryAI: QueryAIFn,
  takeScreenshot: ScreenshotFn,
  executeActions: ExecuteActionFn,
  onProgress: ProgressCallback
): Promise<ClaudeResponse> {
  const totalSteps = plan.steps.length
  let completedSteps = 0
  let finalAnswerText: string | null = null

  for (const step of plan.steps) {
    const stepTimer = startTimer(`step ${step.index}/${totalSteps}: ${step.description.slice(0, 60)}`)
    log('step', `${step.index}/${totalSteps} ${step.description}`)
    onProgress({ stepIndex: step.index, totalSteps, description: step.description, status: 'running' })

    let retries = 0
    let succeeded = false

    while (retries < MAX_RETRIES && !succeeded) {
      const screenshot = await takeScreenshot()
      stepTimer.split('screenshot before')
      const beforeHash = hashScreenshot(screenshot)

      const result = await queryAI(step.description, screenshot, activeWindow)
      stepTimer.split('AI query done')

      if (result.mode === 'answer') {
        finalAnswerText = result.text
        succeeded = true
        break
      }

      if (result.mode === 'action' && result.actions?.length) {
        const firstActionType = result.actions[0].type
        await executeActions(result.actions)
        stepTimer.split(`execute ${firstActionType}`)

        if (shouldVerifyStep(firstActionType)) {
          const afterScreenshot = await takeScreenshot()
          stepTimer.split('screenshot after')
          const { success, detail } = await verifyStep(step.description, afterScreenshot, beforeHash)
          stepTimer.split('verify done')

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

    stepTimer.total()
    onProgress({ stepIndex: step.index, totalSteps, description: step.description, status: succeeded ? 'done' : 'failed' })
    if (succeeded) completedSteps++
    if (!succeeded) break
  }

  log('done', `${completedSteps}/${plan.steps.length} steps complete`)
  // Always return a plain answer-mode result. The renderer would otherwise re-execute
  // the last step's actions array (duplicate typing, double navigation, etc).
  if (finalAnswerText && finalAnswerText.trim()) {
    return { mode: 'answer', text: finalAnswerText } as ClaudeResponse
  }
  const allDone = completedSteps === plan.steps.length
  const summary = allDone
    ? `Done: ${plan.task}`
    : `Stopped after ${completedSteps}/${plan.steps.length} steps: ${plan.task}`
  return { mode: 'answer', text: summary } as ClaudeResponse
}
