# Lumen

> Voice-first AI copilot that sees your screen and drives your apps.
> Hold a hotkey. Speak. Lumen does it.

Lumen is a screen-aware desktop assistant for Windows. It runs silently in the tray, activates with a global hotkey, and can answer questions, navigate your browser, compose messages, research topics, and fill forms — all from one voice command.

![status](https://img.shields.io/badge/status-active%20development-blue) ![platform](https://img.shields.io/badge/platform-Windows-0078D4) ![electron](https://img.shields.io/badge/Electron-4.x-47848F) ![react](https://img.shields.io/badge/React-19-61DAFB) ![license](https://img.shields.io/badge/license-AGPL--3.0-A42E2B)

---

## What it does

| You say… | Lumen does… |
|---|---|
| *"What time is it, and what's the weather in Larnaca?"* | Two parallel AI calls, one merged answer. |
| *"Write an email to my boss that I'm quitting."* | Plans 3 steps → opens Gmail → clicks Compose → fills Subject + Body (leaves To blank for you). Stops before Send. |
| *"Show me the internship roles at Exness."* | Autonomous research loop: searches Google → clicks the top organic result → scrolls → extracts the list → summarizes. |
| *"Open my third email from Sarah."* | Navigates Gmail, identifies row 3 by bbox, clicks. |
| *"Where is the Compose button?"* | Highlights the button on screen. |
| *"How do I add a color grade in DaVinci Resolve?"* | Numbered step-by-step guide with on-screen pulses. |

---

## Features

**Agentic execution**
- Multi-step planner for compose / navigate / fill tasks. Each step is verified; retries on failure.
- Autonomous research agent — up to 8 iterations of search → click → scroll → summarize.
- Request queue (FIFO) so rapid hotkey presses never collide.
- Parallel subtask splitting for read-only questions ("A and B" fires two concurrent AI calls).

**Screen awareness**
- Speculative screenshot on hotkey-down for low latency.
- Active-window detection adapts writing style per app (Gmail, LinkedIn, X/Twitter, Slack, Discord, Notion, Outlook, messaging).
- OCR for click targeting, with bbox fallback and Computer Use refinement on accurate models.

**Voice-first**
- Global hotkey (rebindable via Settings).
- Hold-to-talk → release to send.
- Whisper (OpenAI) for transcription; Web Speech API fallback.
- Wake-word support planned (OpenWakeWord, CPU-only).

**Five response modes**
| Mode | Use | UI |
|---|---|---|
| Answer | Q&A | Top-right card, auto-closes |
| Guide | How-to | HUD with numbered steps + screen highlights |
| Action | "Open / click / type X" | Moves cursor, clicks, types |
| Text Insert | Write/rewrite in focused field | Generates + inserts |
| Locate | "Where is X" | Dim + reveal bbox highlight |

**Settings + themes**
- Tray icon → Settings window with panels: General / Models / Appearance.
- Click-to-capture hotkey picker.
- Model override per role (Planning / Execution / Verification) — text + dropdown.
- 7 themes: Dark, Light, High Contrast, Ocean, Forest, Sunset, Midnight.
- Config persisted to `~/.ai-overlay/config.json`, live-broadcast to all overlay windows.

**Multi-provider model routing**
- Anthropic keys present → Claude Sonnet 4.6 (planning/execution) + Haiku 4.5 (verification).
- OpenAI only → gpt-5-mini + gpt-5-nano.
- `reasoning_effort: minimal` on all OpenAI calls so reasoning tokens don't starve the output budget.

**Structured logging**
Every query tagged and timed — copy the terminal output and paste it into an issue. Tags: `[plan]` `[step]` `[verify]` `[retry]` `[fail]` `[done]` `[time]`. Wall-clock stamp on every line.

---

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Electron main      │  IPC    │  React renderer              │
│  (src/main/)        │ ◄────►  │  (src/renderer/)             │
│                     │         │    HUD / voicebar / answer   │
│  • query-classifier │         │    overlay / highlight /     │
│  • task-planner     │         │    settings window           │
│  • task-queue (L1)  │         └──────────────────────────────┘
│  • task-splitter    │
│  • step-verifier    │
│  • claude.ts        │ ← Anthropic / OpenAI SDK
│  • model-router     │
│  • config           │ ← ~/.ai-overlay/config.json
│  • logger           │
└──────────┬──────────┘
           │ stdio JSON
           ▼
┌──────────────────────────┐
│  Python agent            │
│  (agent/)                │
│  • global hotkey         │
│  • mouse + keyboard      │
│  • screenshot (mss)      │
│  • OCR (pytesseract)     │
│  • active window         │
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
# or OPENAI_API_KEY=sk-proj-...

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
| Cancel in-flight | Press `Escape` — aborts research/plan loops |
| Open Settings | Left-click tray icon or right-click → Settings |
| Edit config file | Right-click tray → Open config folder |

---

## Configuration

Config lives at `~/.ai-overlay/config.json`. Edit via Settings UI or directly.

```jsonc
{
  "version": 1,
  "theme": "ocean",
  "models": {
    "planning": "claude-sonnet-4-6",
    "execution": "gpt-5-mini",
    "verification": "gpt-5-nano"
  },
  "hotkey": "Ctrl+Shift+Space",
  "hudAutoCloseMs": 5000,
  "answerAutoCloseMs": 10000,
  "wakeWord": { "enabled": false, "phrase": "hey lumen" },
  "historyEnabled": true
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
- **API key** — Anthropic (preferred) or OpenAI

---

## Project layout

```
src/
  main/          Electron main — orchestration, AI calls, queue, planner
  preload/       IPC bridge exposed to renderer as window.api
  renderer/      Four React entry points: HUD / voicebar / answer overlay / settings
                 Plus inline HTML for highlight overlay
agent/           Python subprocess — hotkey, input, screenshot, OCR
docs/            Specs and implementation plans under superpowers/
test/            Vitest unit tests
```

---

## Privacy

- All API calls go directly from your machine to Anthropic / OpenAI. Nothing is proxied.
- `.env` is gitignored. `.ai-overlay/config.json` lives in your home directory, never in the repo.
- Conversation history (last 5 exchanges) is kept in memory only; wipe via Settings → General → History toggle.
- No telemetry, no analytics.

---

## Troubleshooting

**Hotkey not detected** → Run terminal as Administrator. The Python `keyboard` package needs elevated privileges on Windows to hook system-wide keys.

**"No API key found"** → `.env` missing or empty. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, restart `npm run dev`.

**Clicks land in wrong spot** → Windows display scaling above 100% offsets coordinates. Set scaling to 100% or run app as Administrator.

**Empty AI responses on gpt-5-mini** → Make sure the planning/execution model override (in Settings → Models) is left blank or set to a real `gpt-5-*` model. Unknown model IDs return empty content with no error.

**Research agent overshoots page** → Reduce `amount` in scroll rules or hit `Escape` and rephrase.

---

## Roadmap

- [x] Agentic multi-step execution with verification
- [x] Request queue + parallel read-only subtasks
- [x] Config file + Settings UI + 7 themes
- [x] Autonomous research agent
- [ ] Wake-word (OpenWakeWord, always-on, CPU-only)
- [ ] Guide mode voice nav ("next step", "repeat that", "go back")
- [ ] First-run onboarding wizard
- [ ] macOS support for the Python agent

---

## License

**GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](./LICENSE).

TL;DR: you're free to use, modify, and redistribute Lumen. But if you run a modified version on a server and let others interact with it over a network (SaaS, hosted fork, competing product), you **must** publish your source under AGPL too. Keeps the project open, discourages closed-source forks.

Not sure if AGPL fits your use case? Open an issue — commercial relicensing terms can be discussed.
