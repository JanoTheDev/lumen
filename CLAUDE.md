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
2. **Renderers** (`src/renderer/`) — entries `index` (HUD), `highlight`, `answeroverlay`, `status`, `dwellring`, `settings`. All windows are sandboxed with CSP; `highlight`/`answeroverlay`/`dwellring` scripts live in `src/renderer/src/legacy/*.ts`.
3. **Agent** — the Rust sidecar `lumen-native` (`native/`), spawned subprocess, protocol v2 NDJSON over stdio.

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
- `agent/` — `bridge` (protocol v2 client: `ready` handshake with timeout, `init` from config resent after every restart, restart backoff, per-command timeouts, per-launch generation), `commands` (typed v2 wrappers), `state` (`buildAgentInitState`: hotkeys, dwell, log level, `mouse-moved` / `focus-changed` subscriptions), `impl` (exe path + `REQUIRED_NATIVE_CAPABILITIES`), `events` (hotkey/dwell/cancel wiring), `escape` (ref-counted global Escape).
- `guides/` — `store` (saved guides, id validation), `voice-nav` (whole-utterance next/back/repeat/done), `session`.
- `teach/bridges/` — lesson `bridge` checks: Blender add-on client (`bridges/blender/lumen_bridge`, TCP 127.0.0.1:47651, token in `%APPDATA%/Lumen/blender-bridge.token`, read-only), obs-websocket v5 client on the global WebSocket (password DPAPI-encrypted in `~/.ai-overlay/bridges.dat`), `expect` DSL (`expect.ts`, keys listed in `skills/schema/bridge-keys.json`). Settings → App helpers. Add-on tests: `python -m unittest discover -s bridges/blender/tests`.
- `speech/` — `stt` (local sherpa-onnx or cloud Whisper), `tts`, `wake/` (sherpa-onnx keyword spotter in main), `dictation/`.
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

Hold hotkey → agent `hotkey-down` → HUD starts recording → release → `hotkey-up` starts a speculative capture while Whisper transcribes → `assistant:query` → overrides → model call (cancellable) → response routed: `answer` card, `guide` highlights, `action` via `executeActions` (safety policy per action), `text_insert`, `locate` dim-and-reveal.

Wake word: agent emits `wake-detected` → same recording flow with client-side VAD auto-stop.

## Settings

Tray icon → Settings window (`src/renderer/src/settings/`). Panels: General, Voice, Accessibility, Interface, Library, Models, Appearance (8 themes incl. custom). Text and number fields save on blur / after a short pause.

## Config

`~/.ai-overlay/config.json`, schema version 2 (`src/shared/config.ts`). A v1 file is migrated in memory; `config.v1.bak.json` is written before the first v2 save. An invalid file is backed up as `config.invalid.<ts>.json` and defaults are used for the bad sections.

```jsonc
{
  "version": 2,
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

Vitest in `test/` (`vitest.config.ts` sets the `@shared` alias). Rust unit tests in `native/` (`cargo test`); `native/conformance/` runs protocol tests against a built `lumen-native.exe`.

## Commit convention

Conventional Commits. Short one-line subjects. **No Co-Authored-By trailers.**
