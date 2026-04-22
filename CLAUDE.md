# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo.

## Commands

```bash
npm run dev          # Electron app + Vite dev server
npm run build        # typecheck + production bundle
npm run build:win    # Windows NSIS installer
npm run lint         # ESLint
npm run format       # Prettier
npm run test         # Vitest (excludes claude.test.ts)
npm run typecheck    # node + web tsconfigs
```

Live-API tests are excluded from `npm test`; run directly: `npx vitest run test/claude.test.ts`.

## Setup

```bash
npm install
python -m venv agent/.venv
agent/.venv/Scripts/pip install -r agent/requirements.txt   # Windows
cp .env.example .env    # set ANTHROPIC_API_KEY and/or OPENAI_API_KEY
npm run dev             # run as Administrator so global hotkey registers
```

The Python `keyboard` lib needs Admin on Windows to suppress the global hotkey. Without Admin the app still runs but the hotkey won't fire.

## Architecture

**Three processes:**

1. **Electron main** (`src/main/`) — planning, queueing, AI calls, config, hotkey/wake state.
2. **React renderer** (`src/renderer/`) — 4 HTML entry points: `index` (HUD), `voicebar`, `highlight`, `answeroverlay`, plus the `settings` window.
3. **Python agent** (`agent/`) — spawned subprocess; JSON IPC over stdio.

### Python agent responsibilities

- Global hotkey (`keyboard` lib, dynamically rebindable via `apply_hotkey()` in `agent/main.py`)
- Mouse + keyboard automation (`actions.py`, `pyautogui`)
- Screenshots (`capture.py`, `mss`)
- Active window title (`capture.py`, `pywinctl`)
- OCR (`pytesseract`)
- **Wake word** (`wake.py`, offline Vosk) — enabled on-demand; emits `wake-detected` event

Agent cmds (stdin JSON): `ping`, `screenshot`, `active_window`, `execute`, `set_hotkey`, `wake_enable`, `wake_disable`, `wake_status`.

### Query flow

**Push-to-talk:** Hold configured hotkey → Python emits `hotkey-down` → `AgentBridge` (`src/main/agent-bridge.ts`) forwards event → main shows HUD + fires `__voiceStart` in renderer → `useVoice` starts MediaRecorder → release → `hotkey-up` → `__voiceStop` → Whisper → `query` IPC → `src/main/claude.ts` → response mode routed to renderer / Python agent.

**Wake word:** Python Vosk loop matches phrase in audio stream → emits `wake-detected` → main fires `__wakeVoiceStart` → same MediaRecorder flow but auto-stops via client-side VAD (1.5s silence after speech, 8s max-wait with no speech).

### Key modules (src/main/)

- `index.ts` — window creation, IPC handlers, event wiring, global hotkey (Escape for cancel), tray.
- `claude.ts` — Anthropic/OpenAI calls, conversation history (last 5 exchanges), app detection for writing style.
- `agent-bridge.ts` — stdio JSON bridge. Auto-restarts agent on non-zero exit. Methods: `screenshot`, `activeWindow`, `execute`, `setHotkey`, `enableWakeWord`, `disableWakeWord`.
- `config.ts` — JSON config at `~/.ai-overlay/config.json`. Shape in `AppConfig`. `DEFAULT_CONFIG.wakeWord.phrase = "hey lumen"`, hotkey `Ctrl+Shift+Space`.
- `wake-model.ts` — auto-downloads `vosk-model-small-en-us-0.15` (~40MB) from alphacephei, extracts via system `tar`, installs to `~/.ai-overlay/vosk-model/`. Broadcasts progress events to Settings window.
- `task-planner.ts` + `task-queue.ts` + `task-splitter.ts` + `step-verifier.ts` — agentic multi-step execution, FIFO queue, parallel read-only splits, per-step verification with retry.
- `model-router.ts` — picks Anthropic vs OpenAI per role based on available keys + per-role overrides.
- `query-classifier.ts` — decides whether to plan/split/short-circuit.
- `nth-utils.ts` — intercepts ordinal phrases ("third button") and corrects AI coordinate selection.
- `logger.ts` — structured logs (`[plan]`, `[step]`, `[verify]`, `[retry]`, `[fail]`, `[done]`, `[time]`).

### Response modes

- `answer` — top-right overlay card, auto-closes (`answerAutoCloseMs`, default 10s).
- `guide` — numbered steps + highlight bboxes in HUD / highlight window.
- `action` — Python agent executes a list of `{move,click,click_bbox,click_element,click_nth_element,type,hotkey,open_url,focus_browser,scroll}`. Chains via optional `follow_up` (max depth 6).
- `text_insert` — AI generates text, main tells Python to `type` it into the focused field.
- `locate` — Computer Use returns bboxes; shown as dim-and-reveal highlights.

### IPC surface (`src/preload/index.ts`)

Exposed as `window.api`. Renderer → main: `query`, `execute-action`, `transcribe`, `close-hud`, `hud-show`, `hide-highlights`, `show-answer-overlay`, `hide-answer-overlay`, `resize-answer-overlay`, `config-get`, `config-save`, `settings-open`, `cancel-current`, `voice-bar-show`, `voice-bar-hide`, `wake-model-status`, `wake-model-install`. Main → renderer: `show-highlights`, `clear-highlights`, `show-pointer`, `show-locate`, `show-answer`, `cancel-request`, `update` (voice transcript), `config-changed`, `wake-model-progress`.

### Speculative screenshots

On `hotkey-up`, main process kicks off `focus_browser` + `screenshot` in parallel with Whisper transcription. Cached for ~4s so the `query` handler skips the 0.8s sequential wait.

## Settings

Tray icon → Settings window (`src/renderer/src/settings/`). Panels: General (hotkey, wake word, timings, history), Models (per-role overrides), Appearance (7 themes).

`HotkeyCapture.tsx` captures key combos live. Saving via `config-save` triggers `agent.setHotkey()` — no restart.

Wake-word toggle handles three states: (1) installs Vosk model if missing (`WakeModelManager` shows progress), (2) enables via `agent.enableWakeWord()` once installed, (3) disables via `agent.disableWakeWord()`.

## TypeScript config

Three tsconfigs. `tsconfig.node.json` builds main + preload (CJS). `tsconfig.web.json` builds renderer (ESNext). Root `tsconfig.json` is a project reference. `electron.vite.config.ts` wires them to Vite.

Two pre-existing typecheck errors in `src/main/index.ts` (unused `isBrowser` import, `never` narrowing on line ~480). Not from recent work.

## Testing

Vitest in `test/`. `claude.test.ts` is excluded from `npm test` (needs live API keys).

## Commit convention

Conventional Commits. Short one-line subjects. **No Co-Authored-By trailers** — user prefers clean git log.

## Config file reference

`~/.ai-overlay/config.json`:

```jsonc
{
  "version": 1,
  "theme": "dark",
  "models": { "planning": "...", "execution": "...", "verification": "..." },
  "hotkey": "Ctrl+Shift+Space",
  "hudAutoCloseMs": 5000,
  "answerAutoCloseMs": 10000,
  "wakeWord": { "enabled": false, "phrase": "hey lumen" },
  "historyEnabled": true
}
```

API keys stay in `.env`, never config.json.
