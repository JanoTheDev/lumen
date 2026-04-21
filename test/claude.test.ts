/**
 * Run: npx tsx test/claude.test.ts
 * Tests pure functions from claude.ts without requiring Electron or the API.
 */

// ── inline the pure functions under test (avoids electron import) ─────────────

type Action = {
  type?: string
  mode?: string
  [k: string]: unknown
}

type ClaudeResponse =
  | { mode: 'answer'; text: string }
  | { mode: 'guide'; steps: unknown[] }
  | { mode: 'action'; actions: Action[]; summary?: string; follow_up?: { query: string; delay_ms: number } }
  | { mode: 'text_insert'; text: string; target_hint: string }

function parseResponse(raw: string): ClaudeResponse {
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    if (parsed.mode !== 'answer' && parsed.mode !== 'guide' && parsed.mode !== 'action' && parsed.mode !== 'text_insert') {
      if (parsed.text || parsed.button) {
        return { mode: 'action', actions: [parsed as Action], summary: '' }
      }
      return { mode: 'answer', text: raw }
    }

    if (parsed.mode === 'action' && (!parsed.actions || (parsed.actions as unknown[]).length === 0)) {
      const url = (parsed.open_url || parsed.url) as string | undefined
      if (url) {
        return {
          mode: 'action',
          actions: [{ type: 'open_url', url }],
          summary: parsed.summary as string | undefined,
          follow_up: parsed.follow_up as { query: string; delay_ms: number } | undefined
        }
      }
    }

    if (parsed.mode === 'action' && Array.isArray(parsed.actions)) {
      parsed.actions = (parsed.actions as Record<string, unknown>[]).map((a) => {
        if (!a.type && a.mode) {
          const { mode: actionMode, ...rest } = a
          return { type: actionMode, ...rest }
        }
        return a
      })
    }

    return parsed as unknown as ClaudeResponse
  } catch {
    return { mode: 'answer', text: raw }
  }
}

function needsScreenshot(prompt: string): boolean {
  const p = prompt.toLowerCase()
  const isLaunch = /^(open|launch|go to|navigate to)\s+\w/i.test(prompt)
  const hasDisambiguator = /\b(from|first|second|third|fourth|fifth|last|latest|recent|top|#\d+|\d+(st|nd|rd|th))\b/i.test(p)
  if (isLaunch && !hasDisambiguator) return false
  return /\b(this|screen|here|that|visible|what.*see|how.*do|button|click|navigate|window|app|page|ui|cursor|tab|menu|field|input|form|element|icon|image|show me|where is|find|select|highlight|email|compose|reply|draft|message|write|rewrite|linkedin|gmail|twitter|slack|notion|edit|insert|paste|recent|latest|first|second|third|last|from|sender|inbox|open|refund|payment|filter|effect|caption)\b/i.test(prompt)
}

function isBrowser(activeWindow: string): boolean {
  const w = activeWindow.toLowerCase()
  return w.includes('firefox') || w.includes('chrome') || w.includes('edge') || w.includes('brave') || w.includes('opera')
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ── parseResponse ─────────────────────────────────────────────────────────────

console.log('\nparseResponse')

{
  const r = parseResponse('{"mode":"answer","text":"hello"}')
  assert('answer mode', r.mode === 'answer' && (r as any).text === 'hello')
}

{
  const r = parseResponse('{"mode":"action","actions":[{"type":"open_url","url":"https://example.com"}]}')
  assert('valid action passthrough', r.mode === 'action' && (r as any).actions[0].type === 'open_url')
}

{
  // AI bug: used "mode" instead of "type" inside action object
  const raw = '{"mode":"action","actions":[{"mode":"click_bbox","bbox":[0,181,1280,233],"button":"left"}]}'
  const r = parseResponse(raw)
  assert('action.mode→action.type normalized', r.mode === 'action')
  const a = (r as any).actions[0]
  assert('type is click_bbox', a.type === 'click_bbox', `got type="${a.type}"`)
  assert('no leftover mode field', a.mode === undefined)
  assert('bbox preserved', JSON.stringify(a.bbox) === '[0,181,1280,233]')
}

{
  // AI put open_url at top level
  const raw = '{"mode":"action","open_url":"https://mail.google.com","follow_up":{"query":"click","delay_ms":3000}}'
  const r = parseResponse(raw)
  assert('top-level open_url → actions array', r.mode === 'action')
  assert('open_url action created', (r as any).actions[0].type === 'open_url')
  assert('open_url url correct', (r as any).actions[0].url === 'https://mail.google.com')
  assert('follow_up preserved', (r as any).follow_up?.delay_ms === 3000)
}

{
  const r = parseResponse('not valid json {{{}')
  assert('invalid JSON → answer fallback', r.mode === 'answer')
}

{
  const r = parseResponse('```json\n{"mode":"answer","text":"hi"}\n```')
  assert('strips markdown fences', r.mode === 'answer' && (r as any).text === 'hi')
}

{
  // text_insert mode
  const r = parseResponse('{"mode":"text_insert","text":"Hello world","target_hint":"compose box"}')
  assert('text_insert passthrough', r.mode === 'text_insert')
}

{
  // Multiple actions, one with mode instead of type
  const raw = '{"mode":"action","actions":[{"type":"open_url","url":"https://mail.google.com"},{"mode":"click_bbox","bbox":[100,200,400,250]}]}'
  const r = parseResponse(raw)
  const actions = (r as any).actions
  assert('first action unchanged', actions[0].type === 'open_url')
  assert('second action mode→type', actions[1].type === 'click_bbox')
}

// ── needsScreenshot ───────────────────────────────────────────────────────────

console.log('\nneedsScreenshot')

assert('open gmail → false', !needsScreenshot('open gmail'))
assert('open google.com → false', !needsScreenshot('open google.com'))
assert('launch cursor → false', !needsScreenshot('launch cursor'))
assert('open youtube → false', !needsScreenshot('open youtube'))
assert('go to twitter → false', !needsScreenshot('go to twitter'))

assert('open my third email → true', needsScreenshot('open my third email on Gmail'))
assert('open Anima from 0xgf → true', needsScreenshot('open Anima from 0xgf'))
assert('open the latest email → true', needsScreenshot('open the latest email'))
assert('open first result → true', needsScreenshot('open the first result'))
assert('what is on my screen → true', needsScreenshot('what is on my screen'))
assert('click the button → true', needsScreenshot('click the button'))
assert('reply to this → true', needsScreenshot('reply to this email'))
assert('write an email → true', needsScreenshot('write an email to my boss'))
assert('how do I refund → true', needsScreenshot('how do I refund a payment'))
assert('show me my inbox → true', needsScreenshot('show me my inbox'))

// ── isBrowser ─────────────────────────────────────────────────────────────────

console.log('\nisBrowser')

assert('Firefox → true', isBrowser('Inbox - Gmail — Mozilla Firefox'))
assert('Chrome → true', isBrowser('Gmail - Google Chrome'))
assert('Edge → true', isBrowser('Gmail — Microsoft Edge'))
assert('Brave → true', isBrowser('Gmail — Brave'))
assert('Opera → true', isBrowser('Gmail — Opera'))
assert('Cursor → false', !isBrowser('main.py - my-project - Cursor'))
assert('Slack → false', !isBrowser('Slack'))
assert('empty → false', !isBrowser(''))
assert('Developer Tools → false', !isBrowser('Developer Tools - http://localhost:5173/'))

// ── coordinate scaling math ───────────────────────────────────────────────────

console.log('\ncoordinate scaling')

{
  const scale = 1.5  // 1920/1280
  const bbox: [number, number, number, number] = [100, 200, 300, 260]
  const cx = Math.round(((bbox[0] + bbox[2]) / 2) * scale)
  const cy = Math.round(((bbox[1] + bbox[3]) / 2) * scale)
  assert('bbox center x scaled', cx === 300, `got ${cx}`)
  assert('bbox center y scaled', cy === 345, `got ${cy}`)
}

{
  const scale = 1.5
  assert('click x scales', Math.round(640 * scale) === 960)
  assert('click y scales', Math.round(360 * scale) === 540)
}

{
  // scale=1 (screen resolution matches screenshot)
  const scale = 1
  const bbox: [number, number, number, number] = [50, 100, 150, 140]
  const cx = Math.round(((bbox[0] + bbox[2]) / 2) * scale)
  const cy = Math.round(((bbox[1] + bbox[3]) / 2) * scale)
  assert('bbox center x no scale', cx === 100, `got ${cx}`)
  assert('bbox center y no scale', cy === 120, `got ${cy}`)
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
