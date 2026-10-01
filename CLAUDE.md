# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo.

## Commands

```bash
npm run dev          # Electron app + Vite dev server
npm run build        # typecheck + production bundle
npm run build:win    # Windows NSIS installer
npm run lint         # ESLint
npm run format       # Prettier
npm run test         # Vitest (skips test/live/**)
npm run test:live    # Vitest on test/live/** only
npm run typecheck    # node + web tsconfigs
agent/.venv/Scripts/python -m pytest agent/tests   # Python agent tests
```

Tests under `test/live/` are skipped by `npm test`; run them with `npm run test:live`. Shared fakes (agent child, electron, displays) are in `test/helpers/`.

## Setup

```bash
npm install
python -m venv agent/.venv
agent/.venv/Scripts/pip install -r agent/requirements.txt -r agent/requirements-dev.txt   # Windows
cp .env.example .env    # set ANTHROPIC_API_KEY and/or OPENAI_API_KEY
npm run dev
```

API keys are read at runtime from `.env` in the working directory, then `<userData>/.env`. They are never bundled at build time and never stored in config.json.

The Python `keyboard` lib may need Admin on Windows to suppress the global hotkey. Without it the app still runs but the hotkey may not fire.

## Architecture

**Three processes:**

1. **Electron main** (`src/main/`) — query pipeline, AI calls, action execution, config, windows.
2. **Renderers** (`src/renderer/`) — entries `index` (HUD), `highlight`, `answeroverlay`, `status`, `dwellring`, `settings`. All windows are sandboxed with CSP; `highlight`/`answeroverlay`/`dwellring` scripts live in `src/renderer/src/legacy/*.ts`.
3. **Agent** — spawned subprocess, NDJSON over stdio: the Python agent (`agent/`) or the Rust sidecar `lumen-native` (`native/`), picked by config `agentImpl`.

### Shared contracts (`src/shared/`, alias `@shared`)

Pure TS imported by main, preload and renderer (ESLint forbids electron/node imports here).

- `types.ts` — `Rect {x,y,w,h}`, `Point`, `Action` (the single action union), `ModelResponse`, `GuideStep`, `ElementNode`, `Target`, `InputStep`.
- `channels.ts` — IPC channel names (`area:verb`) and payload types, `LumenApi`. Zod-free so the sandboxed preload can import it.
- `ipc.ts` — zod validators for renderer → main payloads.
- `config.ts` — config v1/v2 zod schemas, defaults, `migrateV1toV2`, `configPatchSchema`.
- `events.ts` — internal bus events, `AssistantState`, `ScreenScene`.
- `legacy-api.ts` — builds the deprecated `window.api` on top of `window.lumen`.

### Preload

`window.lumen = { invoke(channel, ...args), send(channel, ...args), on(channel, cb) → unsubscribe }`, typed from `channels.ts`. Channels not in the table are rejected. `window.api` is a deprecated compatibility layer built on it.

### Main process (`src/main/`)

- `index.ts` — lifecycle and wiring only.
- `bus.ts` — typed event bus. Features emit; `windows/*` subscribe. Only `windows/*` call `webContents.send`.
- `windows/` — `factory` (secure prefs, `loadRenderer`, navigation guards), one module per window (`hud`, `status`, `answer`, `highlight`, `dwell-ring`, `settings`, `tray`), `registry`.
- `ipc/` — one `registerXxxIpc()` per area; every payload validated (`validate.ts`). Invalid payload → `{ error: 'E_INVALID' }`.
- `query/` — `pipeline` (runQuery), `context` (speculative capture as a promise cache), `overrides` (pure prompt steering, composes flags), `present` (guide/locate output), `research`, `cancel` (`CancelScope` per turn; Escape / voice cancel / `assistant:cancel` cancel all), planner (`task-planner`, `step-verifier`, `task-queue`, `task-splitter`, `query-classifier`, `nth`).
- `actions/` — `executor` (single `executeActions` for renderer, plan and research paths), `coords` (the only image ↔ physical ↔ logical conversions), `agent-action` (model action → agent wire format), `safety` (URL scheme allowlist, hotkey/typing policy), `policy`.
- `ai/` — `index` (`callModel`, `callClaude` alias), `providers/{anthropic,openai}` (singleton clients), `prompts/system`, `prompts/untrusted` (screen text is data, never instructions), `schema` (response parsing), `history`, `router` (provider + model per role), `computer-use`, `pricing`, `app-context`.
- `agent/` — `bridge` (protocol v1/v2 client, restart backoff, per-command timeouts, init replay), `commands` (typed v2 wrappers), `state` (`buildAgentInitState`), `impl` (binary selection, see below), `events` (hotkey/wake/dwell/cancel wiring), `escape` (ref-counted global Escape).
- `guides/` — `store` (saved guides, id validation), `voice-nav` (whole-utterance next/back/repeat/done), `session`.
- `speech/` — `stt` (Whisper, in-memory upload), `tts`.
- `config.ts` — load/migrate/save `~/.ai-overlay/config.json`; `logger.ts`; `wake-model.ts` (Vosk model download).

### Python agent (`agent/`)

- `proto.py` owns stdout (protocol only, single writer thread); logs go to stderr.
- `dispatch.py` — inline, input and read lanes; cancel tokens; per-call `timeoutMs`.
- Protocol v1 by default; v2 (`{v:2,id,cmd,args}`, `ready` handshake, `init`) with `--protocol 2`. The bridge switches to v2 when the first stdout line is the v2 `ready` event.
- Modules: `hotkey` (Electron accelerator parser, `--hotkey`), `dpi` (per-monitor-v2 awareness, set before other imports), `monitors`, `capture` (mss, frame cache), `window` (process-based active window / browser detection), `actions`, `safety`, `pagediff`, `wake` (Vosk), `dwell`.

### Native agent (`native/`)

Rust crate `lumen-native`, protocol v2 only (`--protocol 2`). Build with `cargo build --release` (or `--profile fastrel` for a quicker local build); `cargo test`, `cargo clippy --all-targets -- -D warnings`. `lumen-native --bench` prints capture / OCR / UIA / typing-prep / SendInput latencies (nothing is typed).

### Agent selection (`src/main/agent/impl.ts`)

`agentImpl`: `python` | `native` | `auto` (default). Paths: dev `native/target/release/lumen-native.exe` (then `fastrel`) and `agent/.venv/Scripts/python.exe agent/main.py`; packaged `resources/native/lumen-native.exe` and `resources/agent/lumen-agent.exe` (falls back to the bundled venv). `auto` runs native when the exe exists and its `ready.capabilities` include `REQUIRED_NATIVE_CAPABILITIES` (incl. `execute`), otherwise Python. Native failing to start under `auto`, or crashing 3 times within 60 s under any setting, switches the session to Python (`agent-impl-fallback` event, logged). `agent:info` (invoke) returns the running impl, version, protocol and fallback reason for Settings.

### Coordinates

Model bboxes are `Rect` in screenshot image px. `actions/coords.ts` converts image → physical (agent clicks) → logical (overlay windows draw). Legacy `[x1,y1,x2,y2]` arrays are normalized on parse and when saved guides load.

### Query flow

Hold hotkey → agent `hotkey-down` → HUD starts recording → release → `hotkey-up` starts a speculative capture while Whisper transcribes → `assistant:query` → overrides → model call (cancellable) → response routed: `answer` card, `guide` highlights, `action` via `executeActions` (safety policy per action), `text_insert`, `locate` dim-and-reveal.

Wake word: agent emits `wake-detected` → same recording flow with client-side VAD auto-stop.

## Settings

Tray icon → Settings window (`src/renderer/src/settings/`). Panels: General, Voice, Accessibility, Interface, Library, Models, Appearance (8 themes incl. custom). Text and number fields save on blur / after a short pause.

## Config

`~/.ai-overlay/config.json`, schema version 2 (`src/shared/config.ts`). A v1 file is migrated in memory; `config.v1.bak.json` is written before the first v2 save. An invalid file is backed up as `config.invalid.<ts>.json` and defaults are used for the bad sections.

```jsonc
{
  "version": 2,
  "agentImpl": "auto",
  "theme": "dark",
  "hotkey": "Ctrl+Shift+Space",
  "models": { "provider": "auto" },
  "voice": { "stt": "cloud-batch", "tts": "off", "ttsVoice": "alloy" },
  "a11y": { "uiScale": 1 },
  "wakeWord": { "enabled": false, "phrase": "hey lumen" },
  "privacy": { "saveScreenshots": false, "telemetry": false }
  // ...see configV2Schema for every field
}
```

## Testing

Vitest in `test/` (`vitest.config.ts` sets the `@shared` alias). Pytest in `agent/tests/`.

## Commit convention

Conventional Commits. Short one-line subjects. **No Co-Authored-By trailers.**
