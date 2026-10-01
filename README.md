# Lumen

> A voice-and-cursor AI companion for Windows that sees your screen, points at things, and can operate your PC for you.
> Built for people who can't use a mouse or keyboard comfortably, and for anyone learning complex software.

![status](https://img.shields.io/badge/status-active%20development-blue) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4) ![electron](https://img.shields.io/badge/Electron-39-47848F) ![react](https://img.shields.io/badge/React-19-61DAFB) ![license](https://img.shields.io/badge/license-AGPL--3.0-A42E2B)

Lumen lives in the tray. Hold a hotkey (or say "hey lumen"), ask for something, and it answers, points at the right button, walks you through the steps, or does the task itself while you watch.

---

## Goals

**Operate the whole PC without a mouse or keyboard.** Voice, dwell clicking, switch access and screen-reader output are first-class, not add-ons. Everything Lumen can do should be reachable by voice, keyboard, switch and dwell.

**Teach software by doing it with you.** Ask "how do I add a keyframe in Blender?" and Lumen points at the control, waits for you to do the step, checks it worked, and gives more help if you get stuck. App knowledge comes from open skill packs (Blender, DaVinci Resolve, Windows, and more over time).

**Point accurately.** Lumen uses Windows UI Automation to find real buttons and fields, falls back to numbered marks and on-screen text, and only guesses from pixels as a last resort.

**Fast and calm.** Streaming answers, spoken replies that start while the rest is still being written, and a quiet interface with one assistant bar and one on-screen layer.

**Free and private by default.** One AI key (Anthropic or OpenAI) is all you need. Wake word, OCR and dwell run locally on your CPU. No telemetry, screenshots are not saved, and everything that remembers you stays on your PC.

**Open source.** AGPL-3.0, Windows-first, bring your own key.

---

## What works today

| You say…                                               | Lumen does…                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| _"What's the weather in Larnaca and what time is it?"_ | Splits the question, answers both in one card.                               |
| _"Write an email to my boss that I'm quitting."_       | Opens Gmail, starts a draft, fills subject and body. Stops before Send.      |
| _"Where is the compose button?"_                       | Dims the screen and highlights the target.                                   |
| _"How do I compose in Gmail?"_                         | Numbered step-by-step guide on screen; say "next", "back", "repeat", "done". |
| _"Show me internship roles at Exness."_                | Searches, opens the best result, scrolls, and summarizes.                    |
| _"Rewrite this paragraph."_                            | Writes the text into the field you're in.                                    |
| _"Stop"_ or Escape                                     | Cancels whatever is running, including the model call.                       |

Also available now:

- **Hands-free use:** offline wake word, tap-to-talk with silence detection, voice cancel, dwell clicking with an on-screen ring, adjustable UI scale, spoken answers.
- **Guide library:** save a guide by voice and replay it later against the current screen.
- **Safety:** only web links can be opened, risky shortcuts (Run dialog, terminals) are blocked, and text on screen is never treated as an instruction.
- **Settings:** hotkey, voice, accessibility, models, eight themes; no JSON editing needed.

## Roadmap

**Foundation**

- [x] Security hardening: sandboxed windows, link and shortcut safety policy, validated settings and IPC
- [x] Reliable cancel (Escape or "stop" stops the model call and any pending actions)
- [x] Correct highlights and clicks at any display scaling and on multiple monitors
- [x] Faster, more robust desktop agent (Windows OCR, UI Automation, clipboard-free typing)
- [x] Newer models, prompt caching, structured replies and streaming answers
- [x] AI intent router instead of keyword rules
- [x] CI on Windows (typecheck, lint, tests)

**Redesign**

- [x] New design system: one calm visual language, system font, readable at any size
- [ ] Smooth, physical animations everywhere (springs, no pops, 60–120 fps), with reduced-motion support
- [ ] Assistant bar replacing the HUD, answer card and status bubble
- [ ] Cursor buddy that flies to and points at what it's talking about
- [ ] Rebuilt Settings, plus a tray Home panel
- [ ] First-run setup that asks for exactly one AI key and installs the rest
- [ ] Memory settings: see, edit and delete what Lumen remembers

**Pointing and actions**

- [ ] Element-accurate pointing via UI Automation, numbered marks and a zoom-in second look
- [x] Observe → act → verify loop that never retypes text it already entered
- [ ] Agent mode with permissions, a visible ghost cursor and confirm-before-risky-actions

**Voice**

- [ ] Dictation anywhere: dedicated hotkey, light cleanup, personal dictionary (auto-detects when a text field is focused)
- [ ] Streaming spoken answers with barge-in
- [x] Free local speech recognition and Windows voices by default

**Accessibility**

- [ ] Local voice control ("show numbers", "click 5", "scroll down") without calling the AI
- [ ] Mouse grid, switch scanning and dwell click types (right, double, drag)
- [ ] Screen-reader output (NVDA and Narrator), captions, high contrast

**Teaching**

- [ ] Skill packs for Blender, DaVinci Resolve and Windows
- [ ] Lessons that point, wait for you, check the step and give more help when you're stuck
- [ ] "Continue where we left off" and progress across sessions

**Shipping**

- [ ] Small native helper replacing the Python agent (no Python install needed)
- [ ] One-click installer with auto-update
- [ ] Optional local models (Ollama) for fully offline use

---

## How it works

```
┌──────────────────────────┐   typed IPC   ┌───────────────────────────┐
│ Electron main (src/main) │ ◄───────────► │ Renderers (src/renderer)  │
│ query pipeline, router,  │               │ assistant HUD, highlights,│
│ AI providers, executor,  │               │ answer card, settings     │
│ safety policy, config    │               └───────────────────────────┘
└────────────┬─────────────┘
             │ NDJSON over stdio
┌────────────▼─────────────┐
│ Desktop agent (agent/)   │  hotkey, input, capture, Windows OCR,
│                          │  UI Automation, wake word, dwell
└──────────────────────────┘
```

The main process decides, the renderers draw, the agent touches the OS. Shared types and IPC contracts live in `src/shared/`. See [CLAUDE.md](./CLAUDE.md) for the module map.

---

## Quick start

Requirements: Windows 10 22H2+ or 11, Node.js 22, Python 3.11+, and one API key (Anthropic or OpenAI).

```bash
git clone https://github.com/JanoTheDev/lumen.git
cd lumen
npm install

python -m venv agent/.venv
agent\.venv\Scripts\pip install -r agent/requirements.txt

copy .env.example .env      # add ANTHROPIC_API_KEY or OPENAI_API_KEY
npm run dev
```

Hold **Ctrl+Shift+Space**, speak, release. If the hotkey doesn't fire, try running the terminal as Administrator.

Default models: Claude Sonnet 5.5 for answers and planning, Claude Haiku 4.5 for quick checks; with only an OpenAI key, gpt-5-mini and gpt-5-nano. Override per role in Settings → Models.

---

## Development

```bash
npm run dev          # app + Vite dev server
npm run build        # typecheck + bundle
npm run lint         # ESLint
npm test             # Vitest
npm run test:live    # tests that call real APIs (needs a key)
agent\.venv\Scripts\python -m pytest agent/tests
```

CI runs typecheck, lint, Vitest and pytest on Windows for every push.

---

## Privacy

- Requests go straight from your PC to the AI provider you configured. Nothing is proxied.
- Wake word, OCR, UI Automation and dwell run locally.
- Screenshots are sent with a request and never written to disk.
- API keys stay in `.env` and are never written to the config file.
- No telemetry or analytics.

---

## Troubleshooting

**Hotkey doesn't fire:** run the terminal as Administrator; the keyboard hook can need it.

**"No API key found":** add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `.env` and restart.

**Wake word silent:** Settings → Voice → install the offline model (~40 MB, one time), then enable the wake word.

**Wrong window got the text:** Lumen types into whatever is focused; click the field first, or say which app to use.

---

## License

**GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE). You can use, modify and share Lumen; if you offer a modified version to others over a network, you must publish your source under the same license.
