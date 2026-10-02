// Read the web with me (05 Phase W): the Electron side of web reading. `webTurn` is the
// pipeline's early hook; the ports here use the native agent (document text, address bar,
// OCR), the shared safe GET, the fast model and the action executor (open_url through the
// safety policy, origin user-direct).
import type { ModelResponse } from '@shared/types'
import type { ZodType } from 'zod'
import { PLAIN_STYLE_LINE, answerStyle } from '../a11y/phrases'
import { executeActions } from '../actions/executor'
import { getAgent } from '../agent/instance'
import * as commands from '../agent/commands'
import { recordUsage } from '../ai/cost'
import { parseJsonAs } from '../ai/json'
import { getProvider, hasKey } from '../ai/providers'
import { anthropicClient, toUsage } from '../ai/providers/anthropic'
import { readingLevelPrompt } from '../coach'
import { loadConfig } from '../config'
import { log } from '../logger'
import { replyLanguageLine } from '../speech/language'
import { safeGet, type RobotsCache } from './net'
import type { PagePorts } from './page'
import { paidWebSearch, SEARCH_USD } from './search'
import type { Complete } from './summarize'
import { handleWebTurn, type WebDeps } from './turn'
import { activeStyleBlock } from '../ai/style-runtime'
import { withUsageFeature } from '../usage/scope'

export { setNoteSaver, type NoteSaver, type WebNote } from './notes'
export { clearWebContext } from './context'

const PAGE_HTML_BYTES = 2 * 1024 * 1024
const DOC_MAX_CHARS = 60_000
const SEARCH_FALLBACK_MODEL = 'claude-haiku-4-5'

const robotsCache: RobotsCache = new Map()

const complete: Complete = async <T>(
  system: string,
  user: string,
  schema: ZodType<T>,
  maxTokens: number,
  signal?: AbortSignal
): Promise<T | null> => {
  const { llm, model, effort } = getProvider('fast')
  const res = await withUsageFeature('summarize', () =>
    llm.complete(
      {
        model,
        system: [{ text: system, cacheable: true }],
        messages: [{ role: 'user', content: user }],
        maxTokens,
        effort,
        schema,
        schemaName: 'lumen_web'
      },
      signal
    )
  )
  return res.data ?? parseJsonAs(res.text, schema)
}

const pagePorts: PagePorts = {
  async documentText() {
    const agent = getAgent()
    if (!agent?.hasCapability('uia-text')) return null
    const r = await agent.request<{ text: string; name?: string }>(
      'uia_text',
      { scope: 'document', maxChars: DOC_MAX_CHARS },
      { timeoutMs: 3500 }
    )
    return { text: r.text ?? '', name: r.name }
  },
  async browserUrl() {
    const agent = getAgent()
    if (!agent?.hasCapability('browser-url')) return null
    return commands.browserUrl(agent)
  },
  async ocrWindow() {
    const agent = getAgent()
    if (!agent) return ''
    const w = await commands.activeWindow(agent, { timeoutMs: 1000 })
    if (w.rect.w <= 0 || w.rect.h <= 0) return ''
    const r = await commands.ocr(agent, { region: w.rect }, { timeoutMs: 8000 })
    return r.lines.map((l) => l.text).join('\n')
  },
  async fetchHtml(url, signal) {
    const res = await safeGet(url, {
      signal,
      robots: true,
      robotsCache,
      maxBytes: PAGE_HTML_BYTES,
      overflow: 'cut',
      accept: 'text/html,application/xhtml+xml'
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`the page answered ${res.status}`)
    if (res.contentType && !/html|xml|text\/plain/.test(res.contentType))
      throw new Error('not a web page')
    return { url: res.url, html: res.body }
  },
  log: (msg) => log('plan', msg)
}

function styleLines(): string[] {
  const cfg = loadConfig()
  return [
    answerStyle(cfg) === 'plain' ? PLAIN_STYLE_LINE : '',
    readingLevelPrompt(),
    replyLanguageLine(cfg.voice.language),
    activeStyleBlock()
  ].filter(Boolean)
}

const deps: WebDeps = {
  web: () => loadConfig().web,
  style: () => ({ lines: styleLines() }),
  async browserFront() {
    const agent = getAgent()
    if (!agent) return false
    return (await commands.activeWindow(agent, { timeoutMs: 1000 })).isBrowser
  },
  page: pagePorts,
  complete,
  robotsCache,
  async openUrl(url, userText, signal) {
    const r = await executeActions([{ type: 'open_url', url }], {
      origin: 'user-direct',
      userText,
      signal,
      preview: false
    })
    return !r.denied && !r.blocked && r.executed > 0
  },
  async paidSearch(query, signal) {
    if (!loadConfig().web.paidSearch || !hasKey('anthropic')) return null
    const fast = getProvider('fast')
    const model = fast.provider === 'anthropic' ? fast.model : SEARCH_FALLBACK_MODEL
    const res = await paidWebSearch(query, anthropicClient(), model, styleLines(), signal)
    if (res.usage || res.searches) {
      const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      recordUsage(model, res.usage ? toUsage(res.usage) : zero, false, new Date(), {
        provider: 'anthropic',
        searches: res.searches,
        extraUsd: res.searches * SEARCH_USD,
        feature: 'news'
      })
    }
    return res
  },
  now: () => Date.now(),
  log: (msg) => log('plan', msg)
}

/**
 * The pipeline's early hook: a web reading reply, or null when the utterance is not a web
 * request.
 */
export function webTurn(prompt: string, signal: AbortSignal): Promise<ModelResponse | null> {
  return handleWebTurn(prompt, signal, deps)
}
