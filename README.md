# Lumen

> A voice-first AI companion for Windows that sees your screen, points at things, teaches you software and can operate your PC for you.
> Built for people who can't use a mouse or keyboard comfortably, and for anyone learning complex software.

![status](https://img.shields.io/badge/status-pre--release-orange) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4) ![electron](https://img.shields.io/badge/Electron-39-47848F) ![rust](https://img.shields.io/badge/native%20helper-Rust-B7410E) ![license](https://img.shields.io/badge/license-AGPL--3.0-A42E2B)

Lumen lives in the tray. Hold a hotkey (or say "hey lumen"), ask for something, and it answers, points at the right button, walks you through a lesson, types for you, or does the whole task while you watch. One AI key is all it needs; speech, wake word, OCR and dwell run locally.

---

## What it does

| You say…                                                 | Lumen does…                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| _"What's the weather in Larnaca and what time is it?"_   | Splits the question and answers both in one card, spoken if you like.                        |
| _"Where is the compose button?"_                         | Dims the screen and highlights the real control.                                             |
| _"What's this?"_ (pointing at something)                 | Explains the control under your pointer, on any monitor.                                     |
| _"Teach me Blender."_                                    | Lists lessons for the app you're in; pick one by number.                                     |
| _"Show me how to add a keyframe."_                       | Runs a lesson: points, waits for you, checks the step, gives more help if you stall.         |
| _"Write an email to my boss that I'm quitting."_         | Announces the plan, opens Gmail, fills subject and body. Stops before Send.                  |
| _"Find hotels in Nice for next weekend."_                | Researches the web and shows answer cards with photos, prices, ratings and sources.          |
| _"The cheapest one"_ → _"book it"_                       | Picks from the cards and books it while you watch. Payment and the final click stay yours.   |
| _"In the background, find internships at Exness."_       | Works on it as a background task while you keep using the PC, and tells you when it's done.  |
| _"Show numbers"_ → _"click 5"_                           | Numbers every clickable thing and clicks it, instantly, without calling the AI.              |
| _"Read this aloud"_ / _"Summarize this page"_            | Built-in skills that run on whatever is on screen.                                           |
| _"Top news today"_ → _"open the second one"_             | Short brief from free news feeds, with numbered sources you can open by voice.               |
| _"Click this… move this there"_ (while pointing)         | Point and say: combines your words with where the pointer or gaze was.                       |
| _"Summarize my inbox"_ / _"Reply to this saying I'm in"_ | Works in Gmail, the new Outlook and classic Outlook. Drafts only; sending always asks first. |
| _"Make a Word doc with a packing list."_                 | Creates Word, Excel, CSV, PDF, Markdown or HTML files in `Documents\Lumen`, then opens them. |
| _"Summarize this file"_ (pointing at it in Explorer)     | Reads the file under your pointer, or one you dropped, and can reformat it into a new file.  |
| _"Turn on brief mode."_                                  | Reply styles change how Lumen talks (brief, teacher, friendly, formal, or your own).         |
| _"Every weekday at 9, read me my calendar."_             | Creates a routine that runs on that schedule.                                                |
| _"Undo that."_                                           | Reverses Lumen's last actions where possible, and says what can't be undone.                 |
| _"What changed?"_                                        | Describes what's different on screen since your last command.                                |
| _"What did you just do?"_                                | Reads back the last actions from the local audit log.                                        |
| _"Stop"_ or Escape                                       | Cancels whatever is running, including the model call and pending clicks.                    |

### Ask, point and act

- **Works in any app.** No per-app setup: when an app or task is unfamiliar, Lumen looks up how it works (free official help first, your provider's web search if you allow it), finds the named menus and buttons on screen, and remembers what worked for next time.
- **Accurate pointing.** Windows UI Automation finds real buttons and fields; when an app exposes little, Lumen draws numbered marks, reads the screen with Windows OCR and takes a zoomed second look before it clicks.
- **Agent mode.** Multi-step tasks announce a plan, give you a few seconds to cancel, then run an observe → act → verify loop. It prefers UI Automation so your real pointer usually stays put (a "ghost cursor"), and it never retypes text it already entered. Hard caps on steps, time and cost.
- **Rich answers.** Research questions ("best ramen in Larnaca", "compare these three laptops") end in answer cards with photos, prices, ratings and numbered sources. Prices and ratings are only shown when Lumen actually read them on a source page. Follow up by voice: "the cheapest one", "tell me more about the second", "compare them", "save it", "more like this". Cards open full size as a grid or a sortable table.
- **Book it for me.** "Book the second one" opens the site and fills in the booking as a supervised agent task. Logins, captchas and card checks are handed back to you, Lumen never types into payment fields, and the final Book / Pay / Place order click always asks first, with the price it just read from the page.
- **Background tasks.** Say "in the background…" or "keep an eye on…" and the work runs in parallel without touching your mouse or keyboard. Results land in the Tasks list on Home with a tray badge.
- **Task chat.** Click any task (background, agent or Claude Code) to watch its conversation live, see every step it took, steer it with a message, answer its questions, pause or stop it.
- **Safety first.** Every action is rated low / medium / high risk. Risky ones need your OK ("yes", "always" for this site, or "no"), sending, deleting and buying always ask (Send, Delete and recipient checks also work in Dutch, German, French and Spanish Gmail and Outlook), a recipient or personal detail you never said is shown on the confirm card, dangerous shortcuts (Run dialog, terminals) are blocked, passwords and secrets are redacted, and text on screen is treated as data, never as instructions. Every action is written to a local audit log.
- **Multi-monitor and any display scaling.** Highlights and clicks land in the right place on every screen.
- **Files in and out.** Drop a file (PDF, Word, Excel, PowerPoint, CSV, text, image) on the bar or point at one in File Explorer and ask about it; Lumen can also create Word, Excel, CSV, PDF, Markdown and HTML files, convert and reformat files into new ones, and attach them to an email. Originals are never changed without asking.

### Integrations, automations and Claude Code

- **Integrations:** browse a catalog of well-known MCP servers (Notion, Linear, GitHub, Stripe, Supabase, Microsoft Learn, Playwright and more) and add them with one click and a browser sign-in, or add any MCP server by URL or command. Every tool call goes through the same safety gate; tokens are stored encrypted.
- **Bring your Claude Code setup:** import Claude Code plugins, marketplaces, skills and output styles from a link, a folder or your own `~/.claude`, including marketplace plugins that live in other GitHub repos. Command arguments and connector settings come along; hooks are never imported.
- **Automations:** "every weekday at 9…", "in 20 minutes…", "when a PDF lands in Downloads…", "when I open Excel…", at login, when idle or back online. They run in the background, never take your mouse or speak while you're away, can optionally wake Lumen through Windows Task Scheduler, and risky steps need your pre-approval. Manage them in Settings → Automations.
- **Claude Code by voice:** open a project, give Claude Code a task, hear what it's doing and answer its questions hands-free, using your own `claude` login. An optional autopilot answers routine questions for you, with a hard deny list. Coding skills (from a docs link, an import, or a description) are suggested from your project's dependencies, e.g. Next.js and better-auth, and loaded into the session without touching your repo.

### Voice

- **Free local speech recognition** (sherpa-onnx) by default, offline in English, Spanish, German and French; cloud Whisper is optional and covers more languages.
- **Replies in your language:** English, Spanish, German, French, Italian, Portuguese and Dutch, or auto-detect.
- **Offline wake word** ("hey lumen") and voice cancel, with adjustable sensitivity and microphone choice.
- **Hold or tap** the hotkey; **double-tap** for conversation mode, where every sentence is a question until you stop.
- **Spoken answers** with Windows voices, sentence by sentence, with optional barge-in (talk over it to interrupt).
- **Dictation anywhere:** light cleanup that never drops your words, a personal dictionary that learns from your corrections, and a guard that never presses Enter in terminals.
- **Dictation that keeps up:** "Tuesday, actually Wednesday" types Wednesday; spoken lists, numbers, dates and addresses are formatted; each app gets its own style; select text and say "make this friendlier"; snippets, whisper mode, coding mode ("camel case user name"), "send it", mouse-button push-to-talk, history, notes ("take a note…") and local stats.

### Accessibility

- **Local voice commands:** "show numbers", "click 5", "show grid", "scroll down" and more run instantly, with no AI call. Lumen steps aside when Windows Voice Access or Dragon is running.
- **Point and say:** "click this", "move this… there", "what's that?" use where your pointer or gaze was as you spoke.
- **Community labels:** unnamed buttons get a clear name your screen reader can use, shareable with others.
- **Face gestures** (opt-in, local): open your mouth to click, raise your eyebrows to scroll, tilt your head to pick, with a calibration wizard. Camera frames never leave the PC.
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
- **Practice challenges** per app, with feedback and a streak.
- **App helpers** for Blender and OBS read the app's real state, so lesson checks don't have to guess from the screen.
- **Progress is saved**, so "continue where we left off" works across sessions. A local **learning journal** answers "what did I learn this week?"
- **Lessons from tutorials:** paste a transcript, a web page link or a subtitle file and Lumen drafts a lesson for the real app.
- **Share packs and lessons** as a single `.lumen` file, e.g. a teacher or helper sending one to a learner; install community packs from a file or link.
- **Reading level:** plain, standard or expert explanations; say "explain simpler" or "more detail".

### Skills

Skills are small, shareable abilities written as a `SKILL.md`, optionally with fixed steps that run without the AI. Lumen ships starter skills (read this aloud, summarize this page, reply to this email, screenshot and explain, make text bigger here, morning briefing, clean downloads, export for YouTube, fill this form from my profile) and triggers them by phrase or app. Make your own by saying it ("when I say 'morning', open my mail and calendar"), by doing it once while Lumen records, or with "save that as a skill" after a task went well. Or just describe it: "make a skill that…" writes a full skill for you to review, Lumen offers to save tasks you repeat, and "change my morning skill to also open Slack" edits one by voice. Reply styles are skills too ("turn on teacher mode"). Install and share them from Settings, which also shows each skill's run history.

### Smart helpers

Optional, local, and off by default (Settings → Smart helpers), except undo:

- **Focus mode:** dims everything in a busy app except what you need right now. "Only show the timeline", "show everything".
- **Undo:** "undo that" or "undo the last 3 things" reverses Lumen's actions newest first and says honestly what can't be undone (like a sent email).
- **Shortcut coach:** notices when you keep using a menu for something with a shortcut and suggests it once, or a voice command if keys are hard for you.
- **Comfort:** notices when you seem tired and offers slower timings or bigger targets. It never changes a setting without asking.
- **Error rescue:** spots error dialogs and offers to explain them in plain words, and fix them with your OK.
- **What changed?** describes the difference since your last command, for blind and low-vision users.

### Everything else

- **Home flyout** with an ask box, suggestions, recent questions, background tasks and quick toggles.
- **First-run setup** with profiles, one API key, voice files and a practice round.
- **Settings** for voice, accessibility, buddy and look, models and keys, memory, lessons, skills, connectors, background and routines, smart helpers, app helpers, Claude Code and privacy (eight themes including a custom one); no JSON editing.
- **Memory** you can see, edit and delete, plus a private mode.
- **Usage and cost** per day, shown in Settings.
- **Automatic updates** from GitHub Releases (installed build; the portable build tells you when one is out).
- **Any AI provider:** Anthropic, OpenAI, Google Gemini's free tier (opt-in, with its privacy terms shown), OpenRouter, Groq, Mistral, DeepSeek, Together or any OpenAI-compatible service, and local models through Ollama or LM Studio, auto-detected, with a "local only" mode. Pick a provider and model per job.

---

## Install

Requirements: Windows 10 22H2+ or Windows 11 (x64), a microphone, and one AI key (Anthropic, OpenAI, a free Gemini key, or another compatible service) or a local model in Ollama or LM Studio. No Python, no Admin rights.

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

## Status and roadmap

_Last updated: October 2026._

**Where things stand:** every feature listed above is built, has automated tests (about 375 test files and over 4,400 tests, plus the Rust helper's own tests) and passes CI. Most of it has **not yet been tried by hand in the real app** on a range of PCs, so expect rough edges until the hand-test pass below is done. There is no tagged release yet.

### Done

**Core**

- [x] Security: sandboxed windows, validated settings and IPC, risk-rated safety gate, local audit log, redaction
- [x] Rust native helper (no Python), one-click per-user installer, portable build, auto-update
- [x] Assistant bar, screen layer, cursor buddy, Home flyout, tray, first-run setup, rebuilt Settings, eight themes
- [x] Any provider: Anthropic, OpenAI, Gemini free tier, OpenAI-compatible services, Ollama and LM Studio, local-only mode, a model per job
- [x] Memory you can see and edit, private mode, usage and cost per day

**Pointing and doing**

- [x] Accurate pointing: UI Automation, numbered marks, OCR, zoom-in second look
- [x] AI intent router, agent mode with plan, countdown, ghost cursor and caps
- [x] Works in any app: how-to lookups, on-screen grounding, learned per-app notes
- [x] Gmail and Outlook (new and classic): read, summarize, reply, write, search, attach; send and delete safety in five UI languages
- [x] Rich answer cards with images, prices, ratings and sources for research questions, with voice follow-ups
- [x] Book it for me: supervised booking with a checkout guard (price on the confirm, payment fields left to you)
- [x] Background tasks with a live task chat (steer, answer, pause, stop)
- [x] Automations: time, app, folder, idle, login and network triggers, optional wake when closed
- [x] Undo, what changed, focus mode, shortcut coach, comfort, error rescue
- [x] Files in and out: drop or point at a file; create Word, Excel, CSV, PDF, Markdown and HTML

**Voice**

- [x] Local speech recognition, offline wake word, Windows voices, barge-in, conversation mode, seven reply languages
- [x] Dictation anywhere: corrections, formatting, per-app styles, voice edits, snippets, coding mode, history and notes
- [x] Read the web with me: summarize pages, news briefs from free feeds, open sources by voice

**Accessibility**

- [x] Local voice commands, numbers, mouse grid, dwell click types, switch scanning, eye-gaze tuning, on-screen keyboard
- [x] Point and say ("click this", "move this there")
- [x] Screen reader output (NVDA, JAWS, Narrator), community labels, simple mode, text scale, reduced motion, high contrast
- [x] Face-gesture input (webcam, local, opt-in)

**Teaching and skills**

- [x] App packs for ten apps, 50+ lessons, show me how, record my steps, practice challenges, saved progress, learning journal
- [x] Blender and OBS app helpers for exact lesson checks
- [x] Lessons from tutorial transcripts, web pages and subtitle files; sharing as `.lumen` files
- [x] Skills: `SKILL.md` format, starter skills, make by voice, by recording, by description, or "save that as a skill"
- [x] Reply styles, Claude Code plugin import (also marketplace plugins from other GitHub repos)

**Integrations**

- [x] MCP connectors with per-tool permissions, integrations catalog with browser sign-in
- [x] Claude Code by voice with optional autopilot, coding skills per project

### In progress

- [ ] **Better web research:** read result pages as text instead of screenshots, faster answers with sources

### Next

- [ ] Hand-test pass on real hardware: every surface at 100–200 % scaling, light / dark / high contrast, two monitors, NVDA and keyboard only, motion smoothness
- [ ] Pointing accuracy test set from real apps (Gmail, Outlook, Word, Excel, Slack, VS Code, browsers); the capture tool is ready
- [ ] Lesson-check accuracy measurements
- [ ] Community skills and packs index ("Browse community skills", no account needed)
- [ ] Record a lesson run as a video with a transcript
- [ ] Offline spoken-language detection
- [ ] Head-pointer mouse movement for face gestures
- [ ] First public release

### Maybe later

- Optional paid streaming voices and transcription (OpenAI, Deepgram, ElevenLabs), always opt-in
- DaVinci Resolve app helper (needs a Studio licence to test)
- Driving the browser directly instead of through the screen
- Named assistants / personas
- Latency overlay for developers

### Not planned for now

- Code signing and the "uiAccess" build that works over admin windows (paid certificate required)
- winget package (waits for signing)

---

## Privacy

- Requests go straight from your PC to the AI provider you chose. Nothing is proxied.
- Speech recognition, wake word, OCR, UI Automation and dwell run locally.
- Screenshots are sent with a request and never written to disk.
- API keys come from `.env` (development) or the encrypted key store (Windows DPAPI), never from the config file or logs. Passwords and secrets are redacted before anything reaches the model.
- Memory is off by default, stays on your PC, and can be viewed, edited or wiped in Settings.
- The audit log stays on your PC, stores typed text only as a length and hash (a redacted copy only if you turn that on), and is pruned after 30 days by default.
- The camera is used only while face gestures are on; frames are processed locally and never stored or sent.
- Answer card images come from the page itself or Wikimedia Commons and are cached on your PC for 7 days (in memory only in private mode).
- News and page reading fetch only public https pages, respect robots.txt and never refetch one-time links.
- How-to lookups use free official help first; paid web search only runs if you turned it on, with a daily cap. What worked in each app is remembered locally.
- Google Gemini's free tier is opt-in: outside the EEA, UK and Switzerland, Google may use free-tier prompts (including screenshots) to improve its products. Use a paid key or a local model if that matters to you.
- Task transcripts, dictation history, notes and learned app notes stay on your PC, with secrets redacted.
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
