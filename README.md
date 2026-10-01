# Lumen

> A voice-first AI companion for Windows that sees your screen, points at things, teaches you software and can operate your PC for you.
> Built for people who can't use a mouse or keyboard comfortably, and for anyone learning complex software.

![status](https://img.shields.io/badge/status-active%20development-blue) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4) ![electron](https://img.shields.io/badge/Electron-39-47848F) ![rust](https://img.shields.io/badge/native%20helper-Rust-B7410E) ![license](https://img.shields.io/badge/license-AGPL--3.0-A42E2B)

Lumen lives in the tray. Hold a hotkey (or say "hey lumen"), ask for something, and it answers, points at the right button, walks you through a lesson, types for you, or does the task itself while you watch. One AI key is all it needs; speech, wake word, OCR and dwell run locally.

---

## What it does

| You say…                                               | Lumen does…                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| _"What's the weather in Larnaca and what time is it?"_ | Splits the question and answers both in one card, spoken if you like.                |
| _"Where is the compose button?"_                       | Dims the screen and highlights the real control.                                     |
| _"Teach me Blender."_                                  | Lists lessons for the app you're in; pick one by number.                             |
| _"Show me how to add a keyframe."_                     | Runs a lesson: points, waits for you, checks the step, gives more help if you stall. |
| _"Write an email to my boss that I'm quitting."_       | Opens Gmail, starts a draft, fills subject and body. Stops before Send.              |
| _"Show me internship roles at Exness."_                | Searches, opens the best result, scrolls and summarizes.                             |
| _"Show numbers"_ → _"click 5"_                         | Numbers every clickable thing and clicks it, without calling the AI.                 |
| _"Remember I use the dark theme in Figma."_            | Saves it to local memory (opt-in); _"forget that"_ removes it.                       |
| _"Stop"_ or Escape                                     | Cancels whatever is running, including the model call and pending clicks.            |

### Ask, point and act

- **Accurate pointing.** Windows UI Automation finds real buttons and fields; when an app exposes little, Lumen draws numbered marks, reads on-screen text with Windows OCR and takes a zoomed second look before it clicks.
- **Observe → act → verify.** Multi-step tasks are planned with success criteria, each step is checked (cheap checks first, vision only when needed), and Lumen replans instead of retyping text it already entered.
- **Confirm before risky actions.** Risky steps show a short countdown you can cancel. Only web links can be opened, dangerous shortcuts (Run dialog, terminals) are blocked, and text on screen is never treated as an instruction.
- **Multi-monitor and any display scaling.** Highlights and clicks land in the right place on every screen.

### Voice

- **Free local speech recognition** (sherpa-onnx) by default; cloud Whisper is optional.
- **Offline wake word** ("hey lumen") and voice cancel, with adjustable sensitivity and microphone choice.
- **Hold or tap the hotkey**; tap mode stops on silence with an adaptive noise floor.
- **Spoken answers** with Windows voices, sentence by sentence, and optional barge-in (talk over it to interrupt).
- **Dictation anywhere** (Ctrl+Shift+D, or automatically when a text field has focus): light cleanup that never drops your words, a personal dictionary and a guard that never presses Enter in terminals.

### Accessibility

- **Local voice commands:** "show numbers", "click 5", "show grid", "scroll down" and more run instantly, with no AI call.
- **Mouse grid**, **dwell clicking** with a click-type palette (left, right, double, drag) and an on-screen keyboard.
- **Switch scanning** with a scan ring, menu and scan keyboard for one- or two-switch users.
- **Screen reader output** through NVDA, JAWS or Windows Narrator (UI Automation notifications), plus optional focus narration.
- Follows Windows text size, reduced motion and high-contrast (forced colors); adjustable UI scale and timings; accessibility profiles.
- Global shortcuts for everything (Ctrl+Shift+F1 lists what you can say; F2–F10 for the bar, repeat, numbers, grid, dwell, cancel and keyboard).

### Teaching

- **Skill packs** for Windows, Blender, DaVinci Resolve, Excel, OBS Studio, VS Code, Photoshop, GIMP, Premiere Pro and Figma: glossary, shortcuts, screen regions and ready-made lessons.
- **Lessons** with a hint ladder: point, wait, check, explain _why_, and "do it for me" when you'd rather watch.
- **"Show me how"** generates a lesson on the spot for anything not covered by a pack.
- **Progress is saved**, so "continue where we left off" works across sessions. Write your own lessons or override a pack in your user folder.

### Everything else

- **Home flyout** (Ctrl+Shift+H) with an ask box, suggestions, recent questions and quick toggles.
- **First-run setup** with profiles, one API key, voice files and a practice round.
- **Settings** for hotkeys, voice, accessibility, interface, library, models, memory and appearance (eight themes, including a custom one); no JSON editing.
- **Memory** you can see, edit and delete, a private mode, and per-day usage with a cost estimate.
- **Experimental local models** through Ollama or LM Studio (auto-detected).

---

## Install

Step-by-step guide with the SmartScreen warning, updates and uninstall: [docs/INSTALL.md](./docs/INSTALL.md).

Requirements: Windows 10 22H2+ or Windows 11 (x64), a microphone, and an Anthropic or OpenAI API key. No Python, no Admin rights.

1. Download `Lumen-Setup-<version>.exe` from [Releases](https://github.com/JanoTheDev/lumen/releases), or `Lumen-<version>-portable.exe` to run without installing. Optionally check it against `SHA256SUMS.txt` from the same release: `Get-FileHash .\Lumen-Setup-<version>.exe`.
2. Run it. The builds are not code-signed, so SmartScreen says "Windows protected your PC": click **More info**, then **Run anyway**. Lumen installs for your user only, in `%LOCALAPPDATA%\Programs\lumen`, and opens setup.
3. Paste your API key when asked. It is encrypted with Windows (DPAPI) in `%USERPROFILE%\.ai-overlay\keys.dat`, never in the config file.
4. Hold **Ctrl+Shift+Space**, speak, release.

Speech recognition and wake-word models (about 100 MB and 18 MB) download on first use and are checked against pinned SHA-256 hashes.

The installed version checks for updates once a day, downloads them in the background and installs them when you quit (Settings → About to turn this off); the portable one shows a link instead.

Settings, keys and models live in `%USERPROFILE%\.ai-overlay`; logs in `%APPDATA%\Lumen\logs` (Settings → About → Open logs folder, or Export diagnostics for a zip without keys). Uninstall from Windows Settings → Apps; it asks whether to remove your settings, keys and models too. The portable build never adds start-at-login entries and uses the same settings folder.

### Default shortcuts

| Shortcut               | Action                            |
| ---------------------- | --------------------------------- |
| Ctrl+Shift+Space       | Talk to Lumen (hold, or tap)      |
| Ctrl+Shift+D           | Dictate into the focused field    |
| Ctrl+Shift+H           | Open Home                         |
| Ctrl+Shift+F1          | What can I say?                   |
| Ctrl+Shift+F6 / F7     | Numbers / mouse grid              |
| Ctrl+Shift+F9, Escape  | Cancel                            |
| Ctrl+Alt+→ / ← / H / D | Lesson next / back / help / do it |

All of them can be changed in Settings.

---

## How it works

```
┌──────────────────────────────┐   typed IPC   ┌──────────────────────────────┐
│ Electron main (src/main)     │ ◄───────────► │ Renderers (src/renderer)     │
│ query pipeline, AI router,   │               │ assistant bar, screen layer, │
│ planner + verifier, lessons, │               │ Home, settings, onboarding   │
│ memory, safety, executor     │               └──────────────────────────────┘
└──────────────┬───────────────┘
               │ NDJSON over stdio (protocol v2)
┌──────────────▼───────────────┐
│ lumen-native (native/, Rust) │  hotkeys, SendInput, DXGI capture,
│                              │  Windows OCR, UI Automation, dwell,
└──────────────────────────────┘  screen reader output
```

The main process decides, the renderers draw, the agent touches the OS. The Rust sidecar is the only OS helper and ships in the installer; it is restarted with backoff if it crashes. The wake word and local speech recognition run in the main process (sherpa-onnx). Shared types and IPC contracts live in `src/shared/`; app knowledge lives in `skills/`. See [CLAUDE.md](./CLAUDE.md) for the full module map.

Default models: Claude Sonnet 5.5 for answers and planning and Claude Haiku 4.5 for quick checks; with only an OpenAI key, gpt-5-mini and gpt-5-nano. Override per role in Settings → Models.

---

## Run from source

Requirements: Windows 10 22H2+ or 11, Node.js 22, Rust (https://rustup.rs) for the native helper, and one API key.

```bash
git clone https://github.com/JanoTheDev/lumen.git
cd lumen
npm install
npm run build:native        # Rust helper (native/target/release/lumen-native.exe)

copy .env.example .env      # add ANTHROPIC_API_KEY or OPENAI_API_KEY
npm run dev
```

You can also paste a key in Settings → Models instead of using `.env`.

## Development

```bash
npm run dev              # app + Vite dev server
npm run build            # typecheck + bundle
npm run build:win        # native helper + NSIS installer + portable exe in dist/, then package checks
npm run lint             # ESLint
npm test                 # Vitest
npm run test:live        # tests that call real APIs (needs a key)
npm run validate:skills  # check skill packs against their schema
npm run eval:router      # intent router eval
npm run eval:dictation   # dictation word-preservation eval
cd native && cargo test && cargo clippy --all-targets -- -D warnings
```

CI runs typecheck, lint, Vitest and the Rust checks on Windows for every push.

---

## Roadmap

**Done**

- [x] Security hardening: sandboxed windows, link and shortcut policy, validated settings and IPC
- [x] Reliable cancel, correct clicks at any scaling and on multiple monitors
- [x] Rust native helper with capture, OCR, UI Automation, input, dwell and screen reader output
- [x] AI intent router, structured planner, observe → act → verify loop
- [x] Element-accurate pointing: UI Automation, numbered marks, zoom-in second look
- [x] Local speech recognition, Windows voices, sentence-by-sentence answers, barge-in
- [x] Dictation anywhere
- [x] Local voice commands, numbers, mouse grid, dwell click types, switch scanning
- [x] Screen reader output (NVDA, JAWS, Narrator), text scale, reduced motion, forced colors
- [x] Skill packs for ten apps, lessons with checks and hints, progress across sessions
- [x] Design system, rebuilt Settings, Home flyout, first-run setup, memory settings
- [x] One-click per-user installer and portable build
- [x] Experimental local models (Ollama, LM Studio)

**In progress**

- [ ] New assistant bar and cursor buddy as the default UI (available behind a setting)
- [ ] Smooth spring animations everywhere
- [ ] Agent mode with a visible ghost cursor and per-app permissions
- [ ] Captions and more lesson content
- [ ] Auto-update
- [ ] Connectors and more app firsts

---

## Privacy

- Requests go straight from your PC to the AI provider you chose. Nothing is proxied.
- Speech recognition, wake word, OCR, UI Automation and dwell run locally.
- Screenshots are sent with a request and never written to disk.
- API keys come from `.env` (development) or the encrypted key store (Windows DPAPI), never from the config file or logs.
- Memory is off by default, stays on your PC, and can be viewed, edited or wiped in Settings.
- No telemetry or analytics. Crash dumps stay local.

---

## Troubleshooting

**Hotkey doesn't fire:** another app may own the shortcut; pick a different one in Settings → General. Lumen does not need Administrator rights.

**"No API key found":** paste a key in Settings → Models (or, from source, add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` to `.env` and restart).

**Wake word silent:** turn it on in Settings → Voice; the model downloads once. Raise the sensitivity or pick the right microphone there.

**Wrong window got the text:** Lumen types into whatever is focused; click the field first, or say which app to use.

**Something else:** Settings → About → Export diagnostics, and attach the zip (it contains no keys) to an issue.

---

## License

**GNU Affero General Public License v3.0**, see [LICENSE](./LICENSE). You can use, modify and share Lumen; if you offer a modified version to others over a network, you must publish your source under the same license.
