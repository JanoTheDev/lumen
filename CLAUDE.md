# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo.

## Commands

```bash
npm run dev          # Electron app + Vite dev server
npm run build        # typecheck + production bundle
npm run build:native # cargo build --release of native/ (cargo on PATH or ~/.cargo/bin)
npm run build:win    # build:native + build + NSIS installer + portable exe + verify:package
npm run verify:package  # dist/ checks: asar contents, no keys, native files, sidecar ready, size budgets, SHA256SUMS.txt
npm run lint         # ESLint
npm run format       # Prettier
npm run test         # Vitest (skips test/live/**)
npm run test:live    # Vitest on test/live/** only
npm run typecheck    # node + web tsconfigs
cargo test --manifest-path native/Cargo.toml       # native agent tests
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
```

Tests under `test/live/` are skipped by `npm test`; run them with `npm run test:live`. Shared fakes (agent child, electron, displays) are in `test/helpers/`.

## Setup

```bash
npm install
npm run build:native    # Rust toolchain from rustup.rs
cp .env.example .env    # set ANTHROPIC_API_KEY and/or OPENAI_API_KEY
npm run dev
```

API keys are read at runtime from `.env` in the working directory, then `<userData>/.env` (`%APPDATA%/Lumen`), then the DPAPI vault `~/.ai-overlay/keys.dat` (`src/main/keys/vault.ts`: `getKey`/`hasKey`, `keys.changed` bus event; startup logs only each provider's source). They are never bundled at build time and never stored in config.json.

## Architecture

**Three processes:**

1. **Electron main** (`src/main/`) — query pipeline, AI calls, action execution, config, windows.
2. **Renderers** (`src/renderer/`) — React entries, one html file each: `assistant` (bottom-centre assistant bar; also hosts the voice controller `assistant/VoiceHost.tsx`), `screen` (one click-through layer per display: guide highlights, locate dim-and-reveal, buddy, marks, grid, dwell ring), `panel` (Settings, onboarding and the Home tray flyout, hash routes in `panel/routes.ts`), `a11y` (command sheet, dwell palette, scan keyboard). All windows are sandboxed with CSP and use `window.lumen` only. Shared code: `theme/` (tokens, built-in themes + accent presets, `applyTheme` writes CSS variables and `data-theme` / `data-reduce-motion` on `:root`, WCAG contrast helpers), `ui/` (components, icons, `motion.ts` springs), `voice/` (mic, `useVoice`, VAD, speaker, wake feed), `lib/ipc.ts`.
3. **Agent** — the Rust sidecar `lumen-native` (`native/`), spawned subprocess, protocol v2 NDJSON over stdio.

### Shared contracts (`src/shared/`, alias `@shared`)

Pure TS imported by main, preload and renderer (ESLint forbids electron/node imports here).

- `types.ts` — `Rect {x,y,w,h}`, `Point`, `Action` (the single action union), `ModelResponse`, `GuideStep`, `ElementNode`, `Target`, `InputStep`.
- `channels.ts` — IPC channel names (`area:verb`) and payload types, `LumenApi`. Zod-free so the sandboxed preload can import it.
- `ipc.ts` — zod validators for renderer → main payloads.
- `config.ts` — config v1/v2 zod schemas, defaults, `migrateV1toV2`, `configPatchSchema`.
- `events.ts` — internal bus events, `AssistantState`, `ScreenScene`.

### Preload

`window.lumen = { invoke(channel, ...args), send(channel, ...args), on(channel, cb) → unsubscribe }`, typed from `channels.ts`. Channels not in the table are rejected. Nothing else is exposed.

### Main process (`src/main/`)

- `index.ts` — lifecycle and wiring only.
- `bus.ts` — typed event bus. Features emit; `windows/*` subscribe. Only `windows/*` call `webContents.send`.
- `windows/` — `factory` (secure prefs, `loadRenderer`, navigation guards), `registry`, one module per window: `assistant` (bar state `AssistantView`, status, answer, confirm, caption), `screen-layer`, `settings` (panel window), `home`, `tray`, `command-sheet`, `dwell-palette`, `scan-keyboard`. The assistant module also owns voice start/stop and `setStatus`; the screen layer owns highlight channels and the dwell ring. `status`, `answer`, `highlight`, `dwell-ring` and `ui-mode` are deprecated re-exports kept for a few importers; `lesson` draws lesson scenes.
- `ipc/` — one `registerXxxIpc()` per area; every payload validated (`validate.ts`). Invalid payload → `{ error: 'E_INVALID' }`.
- `query/` — `pipeline` (runQuery; `plan` / `research` routes and navigate-then-act follow-ups run as agent-mode tasks), `router` (local grammar, prefilter, LLM router), `context` (speculative capture as a promise cache), `capture`, `legacy/` (regex steering behind `ai.router: "legacy"`), `present` (guide/locate output), `cancel` (`CancelScope` per turn; Escape / voice cancel / `assistant:cancel` cancel all), `task-queue`, `parallel`, `resolve-target`, `refine`, `nth`.
- `actions/` — `executor` (single `executeActions` for the renderer, agent mode and lessons; `uia_act` and `input` go to their own agent commands), `coords` (the only image ↔ physical ↔ logical conversions), `agent-action` (model action → agent wire format), `safety` (`evaluate(action, ctx)` → low / medium / high / blocked per origin `user-direct|agent|lesson|routine|mcp`: URL schemes, hotkey denylist, terminal and password typing, element-name risk, injection bump), `risk-names`, `redact` (secret detection for typed text, logs and model input), `policy` (`gate`: evaluate → confirm → audit; the executor and lesson do-it call it for every action).
- `agent-mode/` — `runner` (plan → spoken announce → cancel-window countdown → tool-use loop → finish; caps 25 actions / 30 model calls / $0.50 / 5 min ask to continue; one AbortController per task; takes a tool set and an optional input lane), `tools` (strict tool schemas: observe, act, keys, navigate, launch_app, wait_for, ask_user, read_file, finish), `prompts` (stable cacheable system prompt; date, window and app guide in the user turn; observed content fenced as `<observed>`), `session` (one foreground task; "go" / "stop" / "wait", ask_user answers and "resume the task" while it runs; publishes `agent.task` → `AssistantState.agentTask`), `handlers` (real tools), `exec-strategy` (UIA patterns first so the pointer stays put, else buddy-then-input with pointer restore; retry-type guard), `apps` (known-app registry: Start menu `.lnk` + `Get-StartApps`, the only things launch_app starts), `wait-for` (title / element / OCR text, event hints + 4 Hz polling), `ask`, `grants` (`~/.ai-overlay/grants.json`, medium only, `agent:grants-list|revoke`), `confirm` (the bar's confirm card; voice "always" stores a grant). `audit/log` — `~/.ai-overlay/audit/YYYY-MM-DD.ndjson`, one line per executed or denied action, typed text as length + SHA-256, 30-day prune, `audit:list`, "what did you just do".
- `ai/` — `index` (`callModel`: cacheable system prefix + volatile user turn with memory, skill pack, lesson, simple-mode style and reply language), `providers/{anthropic,openai,local}` (one client each; `index` redacts secrets in every message before it is sent, `setDeterministic` for evals), `prompts/` (`core`, `grounding`, `modes/*`, `apps/*`, `router`, `untrusted`: screen text is data, never instructions; `assemble`), `schema` (reply schemas + parsing), `models` (provider + model per role), `stream-reply`/`sentences` (spoken text streamed sentence by sentence), `history`, `memory/` (profile, per-app, working, session, episodes, retrieval, `memory_search` tool), `describe` (`describeScreen`, `explainTarget`), `verify`, `observe`, `skills`, `pricing`/`cost`/`usage-log`, `turn-metrics` (one `[time] turn {json}` log line per turn; `npm run perf:baseline` prints p50/p95 per mode from main.log), `app-context`.
- `agent/` — `bridge` (protocol v2 client: `ready` handshake with timeout, `init` from config resent after every restart, restart backoff, per-command timeouts, per-launch generation), `commands` (typed v2 wrappers), `state` (`buildAgentInitState`: hotkeys, dwell, log level, `mouse-moved` / `focus-changed` subscriptions), `impl` (exe path + `REQUIRED_NATIVE_CAPABILITIES`), `events` (hotkey/dwell/cancel wiring), `escape` (ref-counted global Escape).
- `guides/` — `store` (saved guides, id validation), `voice-nav` (whole-utterance next/back/repeat/done), `session`.
- `skills/` — Claude-style skills (CONTRACTS C10): `SKILL.md` frontmatter + body in `skills/builtin/`, app packs' `skills/<app>/skills/` and `~/.ai-overlay/skills/` (later overrides earlier; user folder watched; on/off and trust in `~/.ai-overlay/skills-state.json`). `registry` (frontmatter only, body read on use), `disclosure` (L1 `skillIndexText` for the cached prefix, `use_skill` / `read_skill_file` / `list_skills` tools), `triggers` (local phrase match), `manage` + `kind` (`.lumen` install with a permissions preview, export, edit, delete via `packs/`). Settings → Skills.
- `teach/bridges/` — lesson `bridge` checks: Blender add-on client (`bridges/blender/lumen_bridge`, TCP 127.0.0.1:47651, token in `%APPDATA%/Lumen/blender-bridge.token`, read-only), obs-websocket v5 client on the global WebSocket (password DPAPI-encrypted in `~/.ai-overlay/bridges.dat`), `expect` DSL (`expect.ts`, keys listed in `skills/schema/bridge-keys.json`). Settings → App helpers. Add-on tests: `python -m unittest discover -s bridges/blender/tests`.
- `teach/recorder` + `teach/recording` — record my steps ("watch me …" / "stop recording"): agent `uia-event`, `focus-changed`, `key-combo` while recording only; typed text never kept (field name only), screenshots only on "take a screenshot" (memory only); fast model writes the `say` lines, draft in `~/.ai-overlay/teach/draft.lesson.json` until saved as a user lesson (voice or Settings → Lessons).
- `packs/` — generic `.lumen` packs (zip of pack folders): `zip-read` (strict reader: no zip-slip / absolute / symlink / zip64, ≤ 50 MB, ≤ 2000 entries), `install` (`PackKind`: manifest, data-only extensions, validate; staged, all-or-nothing, `.lumen-pack.json` marker with trust `community-untrusted`; only marked folders are replaced or removed), `fetch` (GitHub link → raw / release / codeload download, `PACK_HOSTS` allowlist), `skill-kind` (skill packs, validated by `skills/schema/validate.mjs`, shared with `npm run validate:skills`). `teach/packs` is the Electron side; community packs load without "do it for me".
- `speech/` — `stt` (local sherpa-onnx or cloud Whisper), `tts`, `wake/` (sherpa-onnx keyword spotter), `dictation/`. The spotter and the offline recognizer run in one worker thread (`sherpa-worker.ts` → `sherpa-engine.ts`); `sherpa.ts` is main's message API (request/reply by id, crash → new worker). `node scripts/bench-sherpa.mjs` measures their main-thread cost.
- `config.ts` — load/migrate/save `~/.ai-overlay/config.json`; `logger.ts`.

### Native agent (`native/`)

Rust crate `lumen-native`, protocol v2 only (`--protocol 2`; `{v:2,id,cmd,args}` requests, `ready` handshake event first, then `init`; any other request shape is a `protocol-error`). stdout carries only protocol frames (single writer); logs go to stderr. Lanes: inline, input, read; cancel tokens; per-call `timeoutMs`. Build with `cargo build --release` (or `--profile fastrel` for a quicker local build); `cargo test`, `cargo clippy --all-targets -- -D warnings`. `lumen-native --bench` prints capture / OCR / UIA / typing-prep / SendInput latencies (nothing is typed).

### Agent launch (`src/main/agent/impl.ts`)

Dev: `native/target/release/lumen-native.exe`, then `native/target/fastrel/`. Packaged: `resources/native/lumen-native.exe`. A missing exe rejects `start()` with `E_AGENT_MISSING`; crashes and handshake timeouts restart on backoff (a manual `start()` resets it). A ready agent missing a required capability is logged and kept. `agent:info` (invoke) returns `{impl, version, protocol, error}` for Settings and first-run. Old configs with `agentImpl` load fine; the field is ignored.

### Packaging (`electron-builder.yml`, `scripts/`, `build/`)

Windows x64 only, unsigned (no code signing by decision): NSIS one-click per-user installer (no Admin, `%LOCALAPPDATA%/Programs/lumen`) and a portable exe. appId `io.github.janothedev.lumen` = `src/main/app-id.ts`; productName Lumen (userData `%APPDATA%/Lumen`). The asar holds `out/`, `resources/`, `skills/` and prod node_modules (renderer-only deps are devDependencies; TS sources, typings and ESM copies are filtered); `sherpa-onnx-*` and `resources/` are asarUnpacked. extraResources: `native/lumen-native.exe`, `native/nvdaControllerClient.dll`, `third_party/`, `bridges/blender/lumen_bridge/`. Fuses: no RunAsNode, no NODE_OPTIONS / --inspect, asar integrity, only-load-from-asar. Only the en-US Chromium locale ships. `build/installer.nsh`: uninstall removes the HKCU Run entry and asks before deleting `~/.ai-overlay` and `%APPDATA%/Lumen` (never during an update). Budgets in `scripts/verify-package.mjs`: installer ≤ 95 MB, installed ≤ 330 MB, app.asar ≤ 15 MB.

Runtime: `diagnostics/` tees console output to `%APPDATA%/Lumen/logs/main.log` (redacted, 5 × 5 MB), keeps crash dumps local, reloads a crashed renderer (max 3 a minute), and `diag:export` zips logs, dumps, redacted config and versions. `first-run/` serves `firstrun:list|run|fix|complete` (keys, microphone, agent, hotkey, ocr, wake-model, elevation), start at login (`system.startAtLogin`, installed build only; `--hidden` keeps setup closed) and portable detection (`PORTABLE_EXECUTABLE_DIR`). Models download through `downloads/verified-download.ts` (https and a host allowlist on every redirect, pinned SHA-256, staged on the same volume, System32 `tar.exe`).

### Coordinates

Model bboxes are `Rect` in screenshot image px. `actions/coords.ts` converts image → physical (agent clicks) → logical (overlay windows draw). Legacy `[x1,y1,x2,y2]` arrays are normalized on parse and when saved guides load.

### Query flow

Hold hotkey → agent `hotkey-down` → `speech/hotkey` + `speech/activation` (hold; a quick tap, or tap mode, stays hands-free and ends on silence; a double-tap starts a conversation, `speech/conversation`, which listens again after each turn once the reply has been spoken) → the assistant bar's VoiceHost records (16 kHz WAV) → release → speculative capture while `voice:transcribe` runs `speech/stt` (offline sherpa-onnx in the speech worker: Parakeet for English, Canary for es/de/fr per `voice.language`; or OpenAI Whisper with the merged vocabulary) → `assistant:query` → `speech/router-hook` (short answers in the voice language become English words, "stop, …" cancels running work) → confirm answers → intercept (agent mode, lesson words, 06 grammar, prefilter and cancel words) → dictation auto-detect → model call (cancellable) → response routed: `answer` card, `guide` highlights, `action` via `executeActions` (safety policy per action), `text_insert`, `locate` dim-and-reveal. Multi-step and research requests run as an agent-mode task (`agent-mode/session`). `speech/router.ts` holds the order as a pure, tested decision. Spoken replies: `speech.say-chunk` → `speech/tts` (Windows voices through the agent, a voice of the voice language when installed) → WebAudio player in the bar. `[time] voice …` lines mark stt-final, first-token and tts-first-audio from the end of speech (`speech/latency`).

Dictation hotkey: `speech/dictation` (cleanup on the fast model, typed through the agent, terminal guard, recovery file); a name corrected the same way twice joins `dictation.dictionary` (`dictation/learn`, counts in `~/.ai-overlay/dictionary.json`).

Wake word: sherpa-onnx keyword spotting in the speech worker on the bar's mic stream (`voice:wake-pcm`), Vosk in the agent as the fallback → same hands-free recording.

## Settings

Tray icon → Home flyout or the panel window at `#/settings/<section>` (`src/renderer/src/panel/settings/`, sections registered in `meta.ts` + `SettingsPage.tsx`): General, Voice, Accessibility (grouped Seeing / Hearing / Speaking / Thinking and focus / Moving, plus shortcuts), Buddy & look, Models & keys, Memory, Lessons, App helpers, Privacy, About. Text and number fields save on blur / Enter. Retired config fields (`ui.v2`, `hudAutoCloseMs`, `statusBubble`) are dropped when an old file loads.

## Config

`~/.ai-overlay/config.json`, schema version 2 (`src/shared/config.ts`). A v1 file is migrated in memory; `config.v1.bak.json` is written before the first v2 save. An invalid file is backed up as `config.invalid.<ts>.json` and defaults are used for the bad sections.

```jsonc
{
  "version": 2,
  "theme": "dark",
  "hotkey": "Ctrl+Shift+Space",
  "models": { "provider": "auto" },
  "voice": { "stt": "cloud-batch", "tts": "off", "ttsVoice": "alloy" },
  "a11y": { "announce": "auto", "uiScale": 1 }, // auto: speaks through a detected screen reader
  "wakeWord": { "enabled": false, "phrase": "hey lumen" },
  "privacy": { "saveScreenshots": false, "telemetry": false }
  // ...see configV2Schema for every field
}
```

## Testing

Vitest in `test/` (`vitest.config.ts` sets the `@shared` alias). Rust unit tests in `native/` (`cargo test`); `native/conformance/` runs protocol tests against a built `lumen-native.exe`.

## Commit convention

Conventional Commits. Short one-line subjects. **No Co-Authored-By trailers.**
