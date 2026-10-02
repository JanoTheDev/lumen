# Lesson-check eval

`npm run eval:lessons` measures how often a lesson step's `expect` check says the right thing:
**false-pass** (Lumen says the step is done when it is not, the dangerous one) and
**false-fail** (Lumen says "not yet" when the learner did it). It runs offline over
`cases.jsonl` and the fixtures in `fixtures/<app>/<fixture>/`, with no model calls and no
app launched, and writes `eval/reports/lessons-<date>-<sha>.md` plus a `.json` sibling
(gitignored). `test/eval/lessons.test.ts` runs the same cases in `npm test`.

## How a case runs

The `deterministic` strategy is the production check tree (`src/main/teach/checks`,
`startCheck`) with fake ports that read the fixture:

1. The check starts in the **before** state. Its first bridge answer is the baseline for
   `…Changed` keys and `last_operator`, as in a real lesson step.
2. The state switches to **after**, and the after state's `events.json` is delivered
   (UIA events and key combos the agent would have sent while the learner worked).
3. The polls run for about a second, then the learner says "done" (`evaluate()`).

UIA lookups use the production matcher (`teach/element-hits`, interactive elements first,
then every node; the snapshot root is skipped like the real one). The Blender bridge is
the production `blenderBridge` over a fake socket; OBS goes through the production
request → state mapping (`OBS_REQUESTS`). Vision checks answer `unknown` offline.

Verdicts: `pass`, `fail`, `unknown` (the lesson asks "Did it work?") and `manual` (it
passes only because an `anyOf` has a `manual` alternative, so the learner's "done" decides).
`unknown` and `manual` are reported as undecided, not as false results.

The `manual` rule, decided: `manual` on a truth-fail case is **not** scored as a false pass,
even though production passes the step on the learner's "done" without asking. A `manual`
alternative is the lesson author's explicit choice to trust the learner where no check can
tell, and a connected bridge that says "not done" already overrules it (`overruleManual`).
Those cases are still listed in the report's own section ("Passes on the learner's word")
and counted in the "pass on "done" only" column, so a pack that leans on `manual` shows up.
`unknown` is safe either way: the lesson asks "Did it work?" and only a "yes" passes.

Strategies: `deterministic`, `mock` (right for about half the cases, tests the report).
`vision` is listed as not run: it needs before/after frames and a model key.

## Fixture format

```
fixtures/<app>/<fixture>/
  meta.json           {"app": "obs", "synthetic": true, "notes": "…"}
  <state>/            one folder per state (before, after, and any variants)
    uia.json          UIA snapshot of the foreground window (same shape as eval/grounding)
    window.json       {"title": "Settings", "process": "obs64.exe"}
    bridge.json       Blender: the add-on's state. OBS: raw obs-websocket responses keyed
                      by request name ({"GetRecordStatus": {...}, "GetInputList": {...}})
    events.json       optional: [{"kind": "invoked", "element": {"name": "OK", "role": "button"}},
                      {"combo": "Ctrl+T"}] seen between before and this state
    ocr.json          optional OCR words / lines (no deterministic check reads OCR today)
    frame.jpg         optional, for a later vision strategy
```

Bridge keys are the ones in `skills/schema/bridge-keys.json`. A state without
`bridge.json` is a bridge that is not connected.

## cases.jsonl

One JSON object per line:

```jsonc
{
  "id": "obs-mic-picked",
  "fixture": "obs/studio",
  "before": "settings-audio", // state folders (default before / after)
  "after": "settings-audio-mic",
  "step": "obs-basics-02-add-microphone#pick-mic", // <lessonId>#<stepId> from skills/*/lessons
  // or an inline check instead of "step":
  // "expect": {"type": "uia-event", "event": "selected", "match": {"name": "Audio"}},
  "truth": "pass", // pass | fail: was the step really done?
  "category": "completed", // completed | not-started | similar-name | stale-state | partial | wrong-control | no-bridge
  "notes": "…",
  "knownGap": "T15-G2" // optional: a documented gap (it.fails in the test)
}
```

A step reference uses the lesson's normalized check, so a pack change shows up in the
eval. Add tricky negatives next to each positive: a similar name, a state that was already
there before the step began, a step done half way, the right action on the wrong control.

## Adding real frame pairs (operator)

The synthetic fixtures are hand-written. To add a real pair:

1. Open the app on the lesson's starting screen with **demo data** (no real names, files,
   accounts or notifications).
2. Capture the before state: `npm run capture:fixture -- --app <app> --name <fixture>-before`
   (see `eval/grounding/README.md`). Copy its `uia.json` (and `ocr.json`, `frame.jpg` if you
   want them) to `fixtures/<app>/<fixture>/before/`, and write `window.json` from its
   `meta.json` window title and process.
3. Do the step (or a wrong / half version of it) and capture again into `after/` (or a
   named variant such as `after-cancel/`).
4. For a bridge app, save the bridge's answer too: for Blender, the add-on's `state` reply
   (Settings → App helpers shows whether it is connected); for OBS, the obs-websocket
   responses of the requests the step's `expect` uses.
5. If the step relies on UIA events or a key combo, write what happened into the after
   state's `events.json`.
6. Add the case lines with the truth you saw, run `npm run eval:lessons`, and check the
   report. Look at every image before committing: images are never masked.

The vision strategy (a model comparing `before/frame.jpg` with `after/frame.jpg` for the
step's vision prompt) is not built yet; it needs real frame pairs and a key, and costs
money per run, so it will never run in `npm test`.
