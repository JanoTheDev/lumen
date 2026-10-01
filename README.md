# Lumen

> A voice-first AI companion for Windows that sees your screen, points at things, teaches you software and can operate your PC for you.
> Built for people who can't use a mouse or keyboard comfortably, and for anyone learning complex software.

![status](https://img.shields.io/badge/status-active%20development-blue) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4) ![electron](https://img.shields.io/badge/Electron-39-47848F) ![rust](https://img.shields.io/badge/native%20helper-Rust-B7410E) ![license](https://img.shields.io/badge/license-AGPL--3.0-A42E2B)

Lumen lives in the tray. Hold a hotkey (or say "hey lumen"), ask for something, and it answers, points at the right button, walks you through a lesson, types for you, or does the whole task while you watch. One AI key is all it needs; speech, wake word, OCR and dwell run locally.

---

## What it does

| You say…                                               | Lumen does…                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| _"What's the weather in Larnaca and what time is it?"_ | Splits the question and answers both in one card, spoken if you like.                       |
| _"Where is the compose button?"_                       | Dims the screen and highlights the real control.                                            |
| _"What's this?"_ (pointing at something)               | Explains the control under your pointer, on any monitor.                                    |
| _"Teach me Blender."_                                  | Lists lessons for the app you're in; pick one by number.                                    |
| _"Show me how to add a keyframe."_                     | Runs a lesson: points, waits for you, checks the step, gives more help if you stall.        |
| _"Write an email to my boss that I'm quitting."_       | Announces the plan, opens Gmail, fills subject and body. Stops before Send.                 |
| _"In the background, find internships at Exness."_     | Works on it as a background task while you keep using the PC, and tells you when it's done. |
| _"Show numbers"_ → _"click 5"_                         | Numbers every clickable thing and clicks it, instantly, without calling the AI.             |
| _"Read this aloud"_ / _"Summarize this page"_          | Built-in skills that run on whatever is on screen.                                          |
| _"What did you just do?"_                              | Reads back the last actions from the local audit log.                                       |
| _"Stop"_ or Escape                                     | Cancels whatever is running, including the model call and pending clicks.                   |

### Ask, point and act

- **Accurate pointing.** Windows UI Automation finds real buttons and fields; when an app exposes little, Lumen draws numbered marks, reads the screen with Windows OCR and takes a zoomed second look before it clicks.
- **Agent mode.** Multi-step tasks announce a plan, give you a few seconds to cancel, then run an observe → act → verify loop. It prefers UI Automation so your real pointer usually stays put (a "ghost cursor"), and it never retypes text it already entered. Hard caps on steps, time and cost.
- **Background tasks.** Say "in the background…" or "keep an eye on…" and the work runs in parallel without touching your mouse or keyboard. Results land in the Tasks list on Home with a tray badge.
- **Safety first.** Every action is rated low / medium / high risk. Risky ones need your OK ("yes", "always" for this site, or "no"), sending, deleting and buying always ask, dangerous shortcuts (Run dialog, terminals) are blocked, passwords and secrets are redacted, and text on screen is treated as data, never as instructions. Every action is written to a local audit log.
- **Multi-monitor and any display scaling.** Highlights and clicks land in the right place on every screen.

### Voice

- **Free local speech recognition** (sherpa-onnx) by default, offline in English, Spanish, German and French; cloud Whisper is optional and covers more languages.
- **Replies in your language:** English, Spanish, German, French, Italian, Portuguese and Dutch, or auto-detect.
- **Offline wake word** ("hey lumen") and voice cancel, with adjustable sensitivity and microphone choice.
- **Hold or tap** the hotkey; **double-tap** for conversation mode, where every sentence is a question until you stop.
- **Spoken answers** with Windows voices, sentence by sentence, with optional barge-in (talk over it to interrupt).
- **Dictation anywhere:** light cleanup that never drops your words, a personal dictionary that learns from your corrections, and a guard that never presses Enter in terminals.

### Accessibility

- **Local voice commands:** "show numbers", "click 5", "show grid", "scroll down" and more run instantly, with no AI call. Lumen steps aside when Windows Voice Access or Dragon is running.
- **Mouse grid**, **dwell clicking** with a click-type palette (left, right, double, drag) and tremor smoothing that suits eye-gaze and head pointers, plus an on-screen keyboard.
- **Switch scanning** with a scan ring, menu and scan keyboard for one- or two-switch users.
- **Screen reader output** through NVDA, JAWS or Narrator, focus narration, "describe the screen" and "read this".
- **Simple mode** with a calmer bar and plain-language answers.
- Follows Windows text size, reduced motion and high contrast; adjustable UI scale, timings, captions and accessibility profiles.

### Teaching

- **App packs** for Windows, Blender, DaVinci Resolve, Excel, OBS Studio, VS Code, Photoshop, GIMP, Premiere Pro and Figma: glossary, shortcuts, screen regions and 50+ ready-made lessons.
- **Lessons** with a hint ladder: point, wait, check, explain _why_, and "do it for me" when you'd rather watch.
- **"Show me how"** generates a lesson on the spot for anything a pack doesn't cover.
- **Record my steps:** do a task once and Lumen turns it into a lesson you can replay or share.
- **Progress is saved**, so "continue where we left off" works across sessions.
- **Share packs** as a single `.lumen` file; install community packs from a file or link.

### Skills

Skills are small, shareable abilities written as a `SKILL.md`. Lumen ships starter skills (read this aloud, summarize this page, reply to this email, screenshot and explain, make text bigger here, morning briefing, clean downloads, export for YouTube, fill this form from my profile), triggers them by phrase or app, and lets you install, write and share your own from Settings.

### Everything else

- **Home flyout** with an ask box, suggestions, recent questions, background tasks and quick toggles.
- **First-run setup** with profiles, one API key, voice files and a practice round.
- **Settings** for hotkeys, voice, accessibility, interface, library, models, skills, memory and appearance (eight themes including a custom one); no JSON editing.
- **Memory** you can see, edit and delete, plus a private mode.
- **Usage and cost** per day, shown in Settings.
- **Automatic updates** from GitHub Releases (installed build; the portable build tells you when one is out).
- **Experimental local models** through Ollama or LM Studio, auto-detected.

---

## Install

Requirements: Windows 10 22H2+ or Windows 11 (x64), a microphone, and an Anthropic or OpenAI API key. No Python, no Admin rights.

1. Download `Lumen-Setup-<version>.exe` from [Releases](https://github.com/JanoTheDev/lumen/releases), or `Lumen-<version>-portable.exe` to run without installing. Optionally check it against `SHA256SUMS.txt` from the same release: `Get-FileHash .\Lumen-Setup-<version>.exe`.
2. Run it. The builds are not code-signed, so SmartScreen says "Windows protected your PC": click **More info**, then **Run anyway**. Lumen installs for your user only, in `%LOCALAPPDATA%\Programs\lumen`, and opens setup.
3. Paste your API key when asked. It is encrypted with Windows (DPAPI) in `%USERPROFILE%\.ai-overlay\keys.dat`, never in the config file.
4. Hold **Ctrl+Shift+Space**, say what you want, let go.

Speech recognition and wake-word models (about 100 MB and 18 MB) download on first use and are checked against pinned SHA-256 hashes.

Settings, keys and models live in `%USERPROFILE%\.ai-overlay`; logs in `%APPDATA%\Lumen\logs` (Settings → About → Open logs folder, or Export diagnostics for a zip without keys). Uninstall from Windows Settings → Apps; it asks whether to remove your settings, keys and models too. The portable build never adds start-at-login entries and uses the same settings folder.

---

## Keyboard shortcuts

You only need the first one. Everything else is optional, and every shortcut can be changed or turned off in Settings → Accessibility → Shortcuts.

**Talking to Lumen**

| Press                  | What happens                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **Ctrl+Shift+Space**   | Hold it, speak, let go. Or tap once to start and Lumen stops listening when you go quiet. |
| Ctrl+Shift+Space twice | Conversation mode: keep talking back and forth until you say "stop" or press Escape.      |
| **Ctrl+Shift+D**       | Dictate: whatever you say is typed into the text field you're in.                         |
| **Ctrl+Shift+H**       | Open Home (ask box, recent questions, background tasks, quick toggles).                   |
| **Escape**             | Stop whatever Lumen is doing.                                                             |

**Hands-free helpers** (the F-key row, all with Ctrl+Shift)

| Press              | What happens                                                    |
| ------------------ | --------------------------------------------------------------- |
| Ctrl+Shift+**F1**  | Show what you can say.                                          |
| Ctrl+Shift+**F2**  | Jump to the assistant bar (to type instead of talk).            |
| Ctrl+Shift+**F3**  | Repeat the last answer.                                         |
| Ctrl+Shift+**F4**  | Pin the answer so it stays on screen.                           |
| Ctrl+Shift+**F5**  | Close the answer.                                               |
| Ctrl+Shift+**F6**  | Show numbers on everything clickable (then say "click 5").      |
| Ctrl+Shift+**F7**  | Show the mouse grid (say 1–9 to zoom into a box, then "click"). |
| Ctrl+Shift+**F8**  | Pause or resume dwell clicking.                                 |
| Ctrl+Shift+**F9**  | Cancel (same as Escape, for when Escape is taken).              |
| Ctrl+Shift+**F10** | Show the on-screen keyboard.                                    |

F3–F5 only work while an answer is showing, and F8 only while dwell clicking is on, so they don't steal keys from your other apps the rest of the time.

**During a lesson** (only active while a lesson runs)

| Press          | What happens              |
| -------------- | ------------------------- |
| Ctrl+Alt+→ / ← | Next step / previous step |
| Ctrl+Alt+H     | More help with this step  |
| Ctrl+Alt+D     | "Do it for me"            |

You can also just say "next", "back", "help" or "do it".

---

## How it works

```
┌──────────────────────────────┐   typed IPC   ┌──────────────────────────────┐
│ Electron main (src/main)     │ ◄───────────► │ Renderers (src/renderer)     │
│ router, agent mode, lessons, │               │ assistant bar, screen layer, │
│ skills, memory, safety gate, │               │ Home, settings, onboarding   │
│ background tasks, audit log  │               └──────────────────────────────┘
└──────────────┬───────────────┘
               │ NDJSON over stdio
┌──────────────▼───────────────┐
│ lumen-native (native/, Rust) │  hotkeys, SendInput, DXGI capture, Windows OCR,
│                              │  UI Automation, dwell, switch hook, screen reader output
└──────────────────────────────┘
```

The main process decides, the renderers draw, the Rust helper touches the OS. Speech recognition and the wake word run in a worker thread with sherpa-onnx. Shared types and IPC contracts live in `src/shared/`; app packs and built-in skills live in `skills/`. See [CLAUDE.md](./CLAUDE.md) for the full module map.

Default models: Claude Sonnet 5.5 for answers and planning and Claude Haiku 4.5 for quick checks; with only an OpenAI key, gpt-5-mini and gpt-5-nano. Override per role in Settings → Models.

---

## Run from source

Requirements: Windows 10 22H2+ or 11, Node.js 22, the Rust toolchain ([rustup.rs](https://rustup.rs)) and one API key.

```bash
git clone https://github.com/JanoTheDev/lumen.git
cd lumen
npm install
npm run build:native        # builds the Rust helper once
copy .env.example .env      # add ANTHROPIC_API_KEY or OPENAI_API_KEY (or paste a key in Settings later)
npm run dev
```

## Development

```bash
npm run dev              # app + Vite dev server
npm run build            # typecheck + bundle
npm run build:win        # Rust helper + installer + portable exe in dist/, then package checks
npm run lint             # ESLint
npm test                 # Vitest
npm run test:live        # tests that call real APIs (needs a key)
npm run validate:skills  # check app packs against their schema
npm run eval:router      # intent router eval
npm run eval:dictation   # dictation word-preservation eval
npm run eval:grounding   # offline pointing eval
npm run size:report      # bundle size budgets
cargo test --manifest-path native/Cargo.toml
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
```

CI runs typecheck, lint, Vitest, the Rust tests and clippy, and the bundle size check on Windows for every push. Pushing a `v<version>` tag builds the installer and portable exe into a draft GitHub Release.

---

## Roadmap

**Done**

- [x] Security: sandboxed windows, validated settings and IPC, risk-rated safety gate, local audit log
- [x] Rust native helper, no Python needed; one-click per-user installer, portable build, auto-update
- [x] Accurate pointing: UI Automation, numbered marks, OCR, zoom-in second look
- [x] AI intent router, agent mode with plan, countdown, ghost cursor and caps
- [x] Background tasks running in parallel, with a Tasks list on Home
- [x] Local speech recognition, Windows voices, barge-in, conversation mode, seven reply languages
- [x] Dictation anywhere with a learning dictionary
- [x] Local voice commands, numbers, mouse grid, dwell click types, switch scanning, eye-gaze tuning
- [x] Screen reader output (NVDA, JAWS, Narrator), simple mode, text scale, reduced motion, high contrast
- [x] App packs for ten apps, 50+ lessons, show me how, record my steps, saved progress, `.lumen` sharing
- [x] Skills: `SKILL.md` format, built-in starter skills, install and share
- [x] Assistant bar, screen layer, cursor buddy, Home, first-run setup, rebuilt Settings, memory
- [x] Experimental local models (Ollama, LM Studio)

**In progress**

- [ ] **Connectors:** add MCP servers (by URL or command) and let Lumen use their tools, with per-tool permissions
- [ ] **Routines:** run a task on a schedule, paused automatically after repeated failures
- [ ] **Focus mode:** dim everything in a complex app except what the current step needs
- [ ] **Undo what you just did:** "undo that" reverses Lumen's last actions where possible, and says what can't be undone
- [ ] **Coach:** shortcut tips, error rescue ("want me to explain this error?"), fatigue-aware pacing, reading level
- [ ] **"What changed?"** after an action, for blind and low-vision users
- [ ] **Learning journal:** "what did I learn this week?"
- [ ] **Claude Code by voice:** open a project, start and answer a coding session hands-free

**Next**

- [ ] Drop a file (PDF, Word, image) on the assistant bar to ask about it
- [ ] Turn a YouTube or web tutorial into a step-by-step lesson in the real app
- [ ] Community accessibility labels for unlabeled buttons
- [ ] "Put that there": voice plus pointer or gaze for click and drag
- [ ] Skills by voice, by demonstration ("watch me") and "save that as a skill"
- [ ] Practice challenges per app
- [ ] Face-gesture input (webcam, local)
- [ ] Browser research through the page itself, not screenshots
- [ ] Optional streaming cloud voices (paid, opt-in)
- [ ] winget package

---

## Privacy

- Requests go straight from your PC to the AI provider you chose. Nothing is proxied.
- Speech recognition, wake word, OCR, UI Automation and dwell run locally.
- Screenshots are sent with a request and never written to disk.
- API keys come from `.env` (development) or the encrypted key store (Windows DPAPI), never from the config file or logs. Passwords and secrets are redacted before anything reaches the model.
- Memory is off by default, stays on your PC, and can be viewed, edited or wiped in Settings.
- The audit log stays on your PC, stores typed text only as a length and hash, and is pruned after 30 days.
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
