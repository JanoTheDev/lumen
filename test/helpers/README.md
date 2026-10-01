# Test helpers

Shared fakes for vitest. Each helper has a sample test next to it (`*.test.ts`) that shows usage.

- `fake-child.ts`: `FakeChild`, a stand-in for the agent process (`stdin` capture, `stdout`/`stderr` PassThroughs, `kill()`, `emitExit(code)`), with `emitLine(obj)`, `emitRaw(chunks)`, `respondTo(cmd, result)`, `reply`/`replyError` in protocol v2 framing; it sends `ready` on start unless `autoReady: false`. `fakeSpawn()` returns a `spawnFn` for `new AgentBridge({ spawnFn, paths: FAKE_PATHS })` (`FAKE_PATHS` makes the bridge find a native exe). `splitAt(text, byteOffsets)` cuts UTF-8 anywhere, including mid-character.
- `electron-mock.ts`: An `electron` module: `screen` (driven by `displays.ts`), `BrowserWindow` stub, `ipcMain` that records handlers, `shell.openExternal` spy, `app.getPath` to a temp dir, `safeStorage` stub. Call handlers with `invokeHandler(channel, payload)` / `emitIpc(channel, payload)`. `setDisplays(layout)` and `resetElectronMock()`.
- `displays.ts`: Display layouts: 1920x1080@100%, 2560x1440@125%, 2880x1800@150%, 3840x2160@200%, a dual layout (150% primary + 100% on the right) and a negative-origin dual (secondary on the left). `screenAdapterFor(layout)` converts DIP and physical px like Electron on Windows; pass it to `setScreenAdapter` in `coords.ts`.
- `fake-a11y-io.ts`: `fakeA11yIo(opts)`, an `A11yIo` for the voice command dispatcher that records agent input, UIA actions, scenes and feedback (physical px = logical × `scale`), and `node(name, rect)` for UIA elements. Used by `test/a11y/dispatch.test.ts`.
- `fixtures.ts`: `makeConfig(overrides)` (validated v2 config), `tinyJpeg(w, h)` (base64 JPEG header with a size), `tempDir()` (temp dir + cleanup).

Mocking electron (`vi.mock` is hoisted, so import inside the factory):

```ts
vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())
import { invokeHandler, resetElectronMock } from './helpers/electron-mock'
```

Tests that need real API keys live in `test/live/` and only run with `npm run test:live`.
