# AI Overlay

Screen-aware AI desktop copilot. Runs silently in the background. Hold a hotkey to speak. Sees your screen, understands what app you're in, responds — in any app. Speaks responses aloud.

---

## Features

### Voice-first
- **Hold Ctrl+Shift+Space → speak → release** to send. No typing, no clicking.
- On-device speech recognition (Web Speech API, built into Chromium — no extra cost, no audio sent to a speech service).
- Live transcript appears in the HUD while speaking.
- AI speaks every response back using your system's text-to-speech.

### Two-window UI
| Window | Position | Purpose |
|---|---|---|
| **Main HUD** | Bottom center | Mic button, guided steps, actions, text insert |
| **Answer Overlay** | Top right | Auto-appearing card for general text Q&A only |

Answer overlay appears automatically when you ask a general question and disappears after 10 seconds. Main HUD handles everything screen-related.

### Screen awareness
- Screenshots your screen on every relevant query — skipped for general questions that don't need visual context (faster + cheaper).
- Detects the active window title (Gmail, LinkedIn, X, Cursor, Slack, etc.) and adapts tone and format automatically.

### Context-aware writing
| App detected | Writing style |
|---|---|
| Gmail / Outlook | Professional email, proper greeting + sign-off |
| LinkedIn | Engaging, professional, structured posts |
| X (Twitter) | ≤280 chars, punchy, direct |
| Cursor / VS Code | Technical, imperative commit/PR style |
| Slack | Short, casual, no email vibes |
| Discord | Community tone, markdown supported |
| WhatsApp / Telegram | Conversational, natural |

### 4 Response modes
| Mode | When | Where shown |
|---|---|---|
| **Answer** | General questions | Top-right overlay (auto-closes 10s) |
| **Guide** | How-to questions | Bottom HUD — numbered steps |
| **Action** | "Do it for me" | Bottom HUD — moves cursor, clicks, types |
| **Text Insert** | Write/rewrite requests | Bottom HUD — generates text, copy or auto-insert |

### Cursor guidance
- In guide mode: mouse auto-moves to the first target element.
- Pulsing ring + floating label appear on screen at the click location.

### Auto-close
- Main HUD closes 12 seconds after a response.
- Answer overlay closes 10 seconds after appearing.
- Countdown shown. Click it to cancel.

### Dual AI provider
- Set **Anthropic** key → uses Claude Sonnet 4.6 (recommended).
- Set **OpenAI** key → uses GPT-4o (fallback).
- Anthropic takes priority if both keys are present.

---

## How it works

```
Hold Ctrl+Shift+Space  →  HUD opens (bottom center)
                          Recording starts automatically
Speak                  →  Live transcript shown in HUD
Release hotkey         →  Speech submitted
                          Active window detected
                          Screenshot taken (if needed)
                          AI analyzes screen + intent
                          Structured response returned
                          AI speaks the response aloud
                          ┌─ General question → Answer overlay (top right, 10s)
                          └─ Screen question  → HUD (guide / action / text insert)
12 seconds later       →  HUD closes automatically
```

On-device components (no extra cost):
- Speech recognition: Web Speech API (Chromium built-in)
- Text-to-speech: Web Speech Synthesis API (system voices)
- Screen capture: Python `mss` — fastest on Windows, local only
- Hotkey detection: Python `keyboard` — no Electron global shortcut overhead

---

## Prerequisites

- **Node.js** 18+ — [nodejs.org](https://nodejs.org)
- **Python** 3.11+ — [python.org](https://python.org)
- API key (one of):
  - **Anthropic** — [console.anthropic.com](https://console.anthropic.com)
  - **OpenAI** — [platform.openai.com](https://platform.openai.com)

---

## Setup

### 1. Install Node deps

```bash
git clone <your-repo-url>
cd ai-overlay
npm install
```

### 2. Set up Python agent

```bash
python -m venv agent/.venv

# Windows
agent\.venv\Scripts\activate

# Mac/Linux
source agent/.venv/bin/activate

pip install -r agent/requirements.txt
```

Or run the setup script (Windows):
```powershell
.\setup.ps1
```

> **Windows note:** The `keyboard` package requires running as Administrator to hook low-level key events. Right-click your terminal → "Run as administrator" before starting.

### 3. Add your API key

```bash
cp .env.example .env
```

Open `.env` — fill in one key:

```env
# Anthropic (Claude Sonnet 4.6, recommended)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (GPT-4o, use if you don't have Anthropic)
OPENAI_API_KEY=sk-proj-...
```

`.env` is gitignored. It will never be committed.

### 4. Run

```bash
npm run dev
```

App starts silently. No window appears until you hold the hotkey.

---

## Usage

| Action | How |
|---|---|
| **Start speaking** | Hold `Ctrl+Shift+Space` — HUD opens + recording starts |
| **Send** | Release `Ctrl+Shift+Space` |
| **Clear chat** | Click refresh icon in HUD header |
| **Collapse HUD** | Click `—` in HUD header |
| **Dismiss HUD** | Click `✕` or wait 12s |

No text input — voice only.

---

## Keeping Your API Key Private

`.env` is already in `.gitignore`. It won't be staged by `git add .`

**Before every push:**
```bash
git status          # .env must NOT appear here
git diff --cached   # confirm no secrets staged
```

**If you accidentally commit a key:**
1. Revoke it immediately — [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com)
2. Remove from git history:
```bash
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .env" HEAD
git push --force
```

Never share keys via Slack, email, or code. Use a password manager.

---

## Scripts

```bash
npm run dev        # dev mode
npm run build      # production build
npm run build:win  # package as Windows .exe
```

---

## Troubleshooting

**HUD doesn't appear**
→ Hold `Ctrl+Shift+Space`. If nothing happens, run terminal as Administrator (required for the keyboard hook on Windows).

**"No API key found"**
→ Confirm `.env` exists with a real key. Restart `npm run dev`.

**Voice not working**
→ Web Speech API needs internet (uses Google's STT inside Chromium). Check mic permissions in Windows Settings → Privacy → Microphone.

**AI doesn't speak responses**
→ Web Speech Synthesis uses your system's installed voices. Check Windows Settings → Time & Language → Speech — ensure a voice is installed.

**Python agent errors**
→ Test: `agent/.venv/Scripts/python.exe agent/main.py` → type `{"id":1,"cmd":"ping"}` + Enter → should print `{"id":1,"result":"pong"}`.

**Hotkey not detected**
→ Run as Administrator. The `keyboard` package requires elevated permissions to hook system-wide key events on Windows.

**Clicks land in wrong spot**
→ Windows display scaling above 100% offsets coordinates. Set to 100% for demos, or run app as Administrator.
