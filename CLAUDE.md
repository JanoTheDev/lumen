# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Electron app + Vite dev server
npm run build        # TypeScript check + production bundle
npm run build:win    # Windows NSIS installer
npm run lint         # ESLint
npm run format       # Prettier
npm run test         # Vitest (excludes claude.test.ts)
```

Python agent (run separately, requires Admin for global hotkeys):
```bash
cd agent && pip install -r requirements.txt
python main.py
```

Environment: copy `.env.example` → `.env`, set `ANTHROPIC_API_KEY` (primary) and/or `OPENAI_API_KEY` (fallback + Whisper transcription).

## Architecture

**Three-process model:**

1. **Electron main** (`src/main/`) — orchestrates everything
2. **React renderer** (`src/renderer/`) — four separate HTML entry points (`index`, `voicebar`, `highlight`, `answeroverlay`)
3. **Python agent** (`agent/`) — subprocess spawned by main, communicates via JSON IPC over stdio; handles global hotkeys, mouse/keyboard automation, screenshots, active window detection

**Key data flow:**
- User holds `Ctrl+Shift+Space` → Python agent emits `hotkey-down` → `agent-bridge.ts` fires IPC event → renderer activates voice capture → on release, audio sent to Whisper API or Web Speech API → transcript sent via IPC `query` handler in `index.ts` → `claude.ts` calls Claude API → response routed by mode (Answer/Guide/Action/Text Insert) → renderer updates UI and/or Python agent executes system actions

**AI integration (`src/main/claude.ts`):**
- Conversation history kept (last 5 exchanges)
- `detectApp()` identifies active window and selects app-specific writing rules
- `callClaude()` is the main query handler — takes screenshot context when needed
- `findClickCoordinates()` uses Claude Computer Use API to refine click targets
- Primary: Anthropic Claude Sonnet 4.6; fallback: OpenAI GPT-4o

**Response modes:**
- `answer` — Q&A shown in top-right overlay (auto-closes 10s)
- `guide` — Numbered steps shown in HUD
- `action` — AI instructs Python agent to move/click/type
- `text_insert` — Generates text for clipboard or auto-insert
- `locate` — Finds UI element coordinates via Computer Use

**IPC bridge (`src/preload/index.ts`):** Exposes `electronAPI` to renderer via `contextBridge`. All renderer↔main communication goes through named IPC channels.

**Ordinal fix (`src/main/nth-utils.ts`):** Intercepts queries mentioning ordinal elements (e.g., "third button") and corrects AI's coordinate selection via `correctNthElement()`.

**Speculative screenshots:** Main process caches a screenshot on hotkey-down so it's ready when the query arrives — avoids latency on action/locate queries.

## TypeScript Config

Three tsconfigs: root (`tsconfig.json`), `tsconfig.node.json` (main/preload, CommonJS), `tsconfig.web.json` (renderer, ESNext). `electron.vite.config.ts` wires these to the correct Vite build targets.

## Testing

Vitest runs in `test/`. `claude.test.ts` is excluded from `npm run test` (requires live API keys). Run it directly with `npx vitest run test/claude.test.ts` when testing AI responses.
