# Lumen

> Voice-first AI copilot that sees your screen and drives your apps.
> Built for people learning new software and people who can't use a mouse. Everyone gets a keyboard-free way to operate a computer.

Lumen is a screen-aware desktop assistant for Windows. It runs silently in the tray, activates with a global hotkey or a wake word, and can answer questions, navigate your browser, compose messages, research topics, guide you through apps you're learning, and fill forms — all from one voice command.

![status](https://img.shields.io/badge/status-active%20development-blue) ![platform](https://img.shields.io/badge/platform-Windows-0078D4) ![electron](https://img.shields.io/badge/Electron-39-47848F) ![react](https://img.shields.io/badge/React-19-61DAFB) ![license](https://img.shields.io/badge/license-AGPL--3.0-A42E2B)

---

## What it does

| You say… | Lumen does… |
|---|---|
| *"What time is it, and what's the weather in Larnaca?"* | Two parallel AI calls, one merged answer. |
| *"Write an email to my boss that I'm quitting."* | Plans 3 steps → opens Gmail → clicks Compose → fills Subject + Body. Stops before Send. |
| *"Show me the internship roles at Exness."* | Autonomous research loop: Google → top result → scrolls → extracts list → summarizes. |
| *"How do I compose in Gmail?"* | If you're on the wrong page, Lumen navigates to Gmail first, then shows a step-by-step guide with numbered highlights. |
| *"Next" / "back" / "repeat" / "done"* | Advance, rewind, re-announce, or dismiss the current guide — by voice. |
| *"Save guide as compose Gmail"* | Saves the current guide to your library. Replay any time with *"play guide compose Gmail"*. |
| *"Stop" / "cancel"* | Aborts in-flight actions mid-run. |
| *"Where is the Compose button?"* | Dims the screen, highlights the exact bbox. |

---

## Why Lumen

**For accessibility users.** Hands-free operation with tap-to-talk, wake-word, silence-detected auto-stop, voice-cancel, dwell-click, scalable UI, and voice-navigated step guides. No hold-the-hotkey required.

**For people learning new software.** "Explain before do" narrates each action before it runs. Guides show labeled steps next to the cursor. Save a guide once, replay it later as a refresher. Confidence hints warn you when Lumen isn't sure.

**For everyone.** Speak naturally — Lumen figures out whether you want an answer, a guide, an action, a write-in-place, or a highlight.

---

## Features

**Agentic execution**
- Multi-step planner for compose / navigate / fill tasks. Each step is verified; retries on failure.
- Autonomous research agent — up to 8 iterations of search → click → scroll → summarize.
- App-switch detection — if you mention Gmail/Outlook/YouTube/etc. while on a different page, Lumen navigates to the right site before doing anything else.
- Request queue (FIFO) so rapid hotkey presses never collide.
- Parallel subtask splitting for read-only questions ("A and B" fires two concurrent AI calls).

**Screen awareness**
- Speculative screenshot on hotkey-down for low latency.
- Active-window detection adapts writing style per app (Gmail, LinkedIn, X/Twitter, Slack, Discord, Notion, Outlook, messaging).
- OCR for click targeting, with bbox fallback and Computer Use refinement on accurate models.

**Voice input**
- Global hotkey — rebindable live from Settings, pushed to the Python agent without restart.
- **Hands-free / tap-to-talk** — press once, recording auto-stops on silence.
- **Offline wake word** ("hey lumen") — Vosk-based, fully local, zero cloud cost.
- **Voice cancel** — say "stop" / "cancel" / "abort" / "never mind" to kill in-flight actions.
- **Voice vocabulary** — feed Whisper your brand names and jargon so it transcribes them right.
- Silence detection tunable per user (silence window, max-wait, speech threshold).

**Guide mode**
- Numbered highlights drawn over UI elements.
- Floating label next to the cursor with big readable text ("2/5: Click Compose button…"), not a tiny tooltip at the bottom.
- Voice nav: "next", "back", "repeat", "done". Zero AI cost — matched locally.
- Guide library: save the current guide with a name, replay any saved guide later. Replays re-run the task against the current screen so bboxes always match.

**Accessibility**
- **UI scale** — 75% – 160% slider, applied live to HUD, answer card, and status bubble.
- **Dwell click** — hover over any UI element for N ms to auto-click. For motor-limited users.
- **Narrate actions** — status bubble shows "About to: click Compose" for ~1s before the click fires.
- **Confidence hints** — when Lumen isn't sure, it says so and gives you a chance to cancel.
- **TTS answers** — OpenAI TTS reads answer overlays aloud. Six voices.

**Status bubble**
- Bottom-center pill shows `listening → transcribing → thinking → acting/step` with a live step counter.
- Non-invasive. Click-through. Toggleable.

**Five response modes**
| Mode | Use | UI |
|---|---|---|
| Answer | Q&A | Top-right card, auto-closes |
| Guide | How-to | Screen highlights + floating step label at cursor |
| Action | "Open / click / type X" | Moves cursor, clicks, types |
| Text Insert | Write/rewrite in focused field | Generates + inserts |
| Locate | "Where is X" | Dim + reveal bbox highlight |

**Themes**
- 7 presets: Dark, Light, High Contrast, Ocean, Forest, Sunset, Midnight.
- **Custom theme** — 3-color picker (accent, background, foreground) live-applied to every overlay window.

**Settings — 7 panels**
- **General** — hotkey, hands-free mode, history.
- **Voice** — wake word, cancel voice, Whisper vocab, VAD tuning.
- **Accessibility** — UI scale, narrate actions, confidence, TTS, dwell click.
- **Interface** — status bubble, overlay auto-close timings, guide dismissal behavior.
- **Library** — saved guides: save the last guide with a name, play, delete.
- **Models** — per-role model overrides (Planning / Execution / Verification).
- **Appearance** — theme presets + custom colors.

Every tunable knob has a sane default and is editable in the UI — no JSON editing required.

**Multi-provider model routing**
- Anthropic keys present → Claude Sonnet 4.6 (planning/execution) + Haiku 4.5 (verification).
- OpenAI only → gpt-5-mini + gpt-5-nano.

**Structured logging**
Every query tagged and timed. Tags: `[plan]` `[step]` `[verify]` `[retry]` `[fail]` `[done]` `[time]`. Wall-clock stamp on every line.

---

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Electron main      │  IPC    │  React renderer              │
│  (src/main/)        │ ◄────►  │  (src/renderer/)             │
│                     │         │    HUD / voicebar / answer   │
│  • query-classifier │         │    overlay / highlight /     │
│  • task-planner     │         │    status bubble / settings  │
│  • task-queue (L1)  │         └──────────────────────────────┘
│  • task-splitter    │
│  • step-verifier    │
│  • claude.ts        │ ← Anthropic / OpenAI SDK
│  • model-router     │
│  • wake-model       │ ← Vosk auto-installer
│  • guide library    │ ← ~/.ai-overlay/guides/*.json
│  • config           │ ← ~/.ai-overlay/config.json
│  • logger           │
└──────────┬──────────┘
           │ stdio JSON
           ▼
┌──────────────────────────┐
│  Python agent            │
│  (agent/)                │
│  • global hotkey (dyn.)  │
│  • mouse + keyboard      │
│  • screenshot (mss)      │
│  • OCR (pytesseract)     │
│  • active window         │
│  • wake + cancel voice   │
│  • dwell-click tracker   │
└──────────────────────────┘
```

Three processes, three responsibilities. The Electron main process plans and decides; the React renderer shows UI; the Python agent owns low-level OS interaction.

---

## Quick start

```bash
# 1. Clone
git clone <repo-url>
cd lumen

# 2. Node deps
npm install

# 3. Python agent
python -m venv agent/.venv
agent\.venv\Scripts\activate        # Windows
# source agent/.venv/bin/activate   # macOS / Linux
pip install -r agent/requirements.txt

# 4. API key — copy .env.example → .env and fill one
cp .env.example .env
#   ANTHROPIC_API_KEY=sk-ant-...   (recommended)
# or OPENAI_API_KEY=sk-proj-...    (required for Whisper + TTS)

# 5. Run (must be Administrator on Windows for global hotkey)
npm run dev
```

Hold **Ctrl+Shift+Space**, speak, release.

Windows setup helper:

```powershell
.\setup.ps1
```

---

## Usage

| Action | How |
|---|---|
| Start speaking | Hold `Ctrl+Shift+Space` (default, rebindable) |
| Send | Release the hotkey |
| Hands-free (push-to-talk optional) | Enable Settings → General → Hands-free. Tap hotkey once; Lumen stops on silence. |
| Wake word | Enable Settings → Voice. Say "hey lumen &lt;your question&gt;". |
| Advance a guide | Say "next" / "back" / "repeat" / "done" |
| Save the guide you just ran | Say "save guide as &lt;name&gt;" or use Settings → Library |
| Replay a saved guide | Say "play guide &lt;name&gt;" or click Play in Library |
| Cancel in-flight | Press `Escape`, or say a cancel phrase (default "stop", "cancel") |
| Open Settings | Left-click tray icon or right-click → Settings |
| Edit config file | Right-click tray → Open config folder |

### Wake word

Offline, free, local. Powered by [Vosk](https://alphacephei.com/vosk/).

1. Settings → Voice → Wake word → click **Install offline model** (~40MB, one-time download).
2. Toggle **Enable always-on wake word** ON. Default phrase: `hey lumen`.
3. Say the phrase followed by your query. HUD opens; recording auto-stops on silence (tunable).

Model lives at `~/.ai-overlay/vosk-model/`. Delete that folder to force re-download.

### Guide library

Save the tutorials Lumen generates and reuse them later.

1. Ask Lumen "how do I X in app Y". Guide renders.
2. Say "save guide as X" or Settings → Library → Save.
3. Replay from voice ("play guide X") or Library → Play.

Replays re-run the task against the current screen — bboxes always track the latest UI.

---

## Configuration

Config lives at `~/.ai-overlay/config.json`. Edit via Settings UI or directly.

```jsonc
{
  "version": 1,
  "theme": "ocean",
  "themeCustom": { "accent": "#7c92ff", "background": "#0d0f14", "foreground": "#e6e8ee", "opacity": 0.92, "blur": 14 },
  "models": {
    "planning": "claude-sonnet-4-6",
    "execution": "gpt-5-mini",
    "verification": "gpt-5-nano"
  },
  "hotkey": "Ctrl+Shift+Space",
  "hudAutoCloseMs": 5000,
  "answerAutoCloseMs": 10000,
  "wakeWord":    { "enabled": false, "phrase": "hey lumen" },
  "cancelVoice": { "enabled": false, "phrases": "stop, cancel, abort, never mind" },
  "tts":         { "enabled": false, "voice": "alloy" },
  "dwellClick":  { "enabled": false, "dwellMs": 1400, "cooldownMs": 1500 },
  "vad":         { "silenceMs": 1500, "maxWaitMs": 8000, "speechThreshold": 0.04 },
  "statusBubble": { "enabled": true },
  "voiceVocab": "",
  "explainBeforeDo": true,
  "showConfidence": false,
  "handsFreeMode": false,
  "guideAutoDismissOnMove": false,
  "historyEnabled": true,
  "historyExchanges": 5,
  "uiScale": 1
}
```

API keys stay in `.env`. They are never written to `config.json`.

---

## Scripts

```bash
npm run dev          # Electron + Vite dev server
npm run build        # type-check + bundle
npm run build:win    # Windows NSIS installer
npm run lint         # ESLint
npm run format       # Prettier
npm test             # Vitest (excludes live-API tests)
```

---

## Requirements

- **Windows 10/11** (Python agent tested on Windows only)
- **Node.js** 18+
- **Python** 3.11+
- **Administrator privileges** (required for `keyboard` package to register the global hotkey)
- **API key** — Anthropic (preferred) or OpenAI (required for Whisper + TTS)

---

## Project layout

```
src/
  main/          Electron main — orchestration, AI calls, queue, planner, guide library, wake-model installer
  preload/       IPC bridge exposed to renderer as window.api
  renderer/      React entries: HUD / voicebar / answer overlay / settings / status bubble
                 Plus inline HTML for highlight overlay
agent/           Python subprocess — hotkey, input, screenshot, OCR, Vosk wake/cancel, dwell tracker
test/            Vitest unit tests
```

Guide library files: `~/.ai-overlay/guides/*.json`

---

## Privacy

- All API calls go directly from your machine to Anthropic / OpenAI. Nothing is proxied.
- Wake word and dwell-click run **100% offline** on your CPU (Vosk + pyautogui).
- `.env` is gitignored. `.ai-overlay/` lives in your home directory, never in the repo.
- Conversation history is kept in memory only; wipe via Settings → General.
- No telemetry, no analytics.

---

## Troubleshooting

**Hotkey not detected** → Run terminal as Administrator. The Python `keyboard` package needs elevated privileges on Windows to hook system-wide keys.

**"No API key found"** → `.env` missing or empty. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, restart `npm run dev`.

**Clicks land in wrong spot** → Windows display scaling above 100% offsets coordinates. Set scaling to 100% or run app as Administrator.

**Empty AI responses on gpt-5-mini** → Make sure the planning/execution model override (Settings → Models) is blank or a real `gpt-5-*` ID. Unknown model IDs return empty content with no error.

**Research agent overshoots page** → Say "cancel" / press Escape and rephrase.

**Wake word not firing** → Check Python console for `[listener] listening (offline)`. If absent: model missing (Settings → Voice → Install) or `vosk`/`sounddevice` not installed (`pip install -r agent/requirements.txt`).

**Microphone stays active when idle** → Only when wake word or cancel voice is enabled. Turn both off in Settings → Voice to release the mic.

**"Vosk model not found" on toggle** → Auto-installer failed (firewall / proxy). Download `vosk-model-small-en-us-0.15.zip` from https://alphacephei.com/vosk/models and extract contents directly into `~/.ai-overlay/vosk-model/` (must contain `am/`, `conf/` folders at the top level).

**Guide shows wrong steps for another app** → App-switch classifier should catch this. If it didn't, mention the app explicitly ("open Gmail and then how do I compose"). Report the prompt so we can extend the app map.

**TTS delay** → First synth call has a ~1s cold-start. Subsequent answers are faster.

---

## Roadmap

- [x] Agentic multi-step execution with verification
- [x] Request queue + parallel read-only subtasks
- [x] Config file + Settings UI + 7 themes + custom colors
- [x] Autonomous research agent
- [x] Offline wake-word (Vosk, CPU-only, free)
- [x] Live hotkey rebind (no restart)
- [x] Guide voice nav ("next", "back", "repeat", "done")
- [x] Guide library (save / replay / delete)
- [x] Hands-free tap-to-talk with silence auto-stop
- [x] Mid-action voice cancel
- [x] TTS answers
- [x] Dwell-click
- [x] UI scale + narrate-before-do + confidence hints
- [x] App-switch classifier (Gmail, Outlook, LinkedIn, X, Notion, Discord, Slack, YouTube, GitHub, Reddit, Spotify, Maps, Calendar, Drive, Docs, Sheets, WhatsApp, Telegram)
- [ ] Dwell-click visual ring overlay
- [ ] First-run onboarding wizard
- [ ] App-specific guided tours (open Photoshop → "want a tour?")
- [ ] Bundled Python (PyInstaller) for one-click installer
- [ ] macOS support for the Python agent

---

## License

**GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](./LICENSE).

TL;DR: you're free to use, modify, and redistribute Lumen. But if you run a modified version on a server and let others interact with it over a network (SaaS, hosted fork, competing product), you **must** publish your source under AGPL too. Keeps the project open, discourages closed-source forks.

Not sure if AGPL fits your use case? Open an issue — commercial relicensing terms can be discussed.
