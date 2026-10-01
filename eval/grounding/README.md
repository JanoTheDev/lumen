# Grounding eval fixtures

`npm run eval:grounding` scores how often Lumen finds the right thing on screen. It runs offline over
`cases.jsonl` and the fixtures in `fixtures/<app>/<screen>/`. The first fixtures are synthetic
(`"synthetic": true` in `meta.json`). Real ones are captured with `npm run capture:fixture`.

## Fixture format

```
fixtures/<app>/<screen>/
  frame.jpg         full-resolution capture of the target window's monitor
  frame_1280.jpg    the 1280 px wide copy the model sees
  meta.json         app, capture date, monitor (physical px + scale), window, frame sizes, theme, locale
  uia.json          UIA snapshot of the foreground window ({} when UIA saw nothing)
  ocr.json          OCR words and lines (optional)
```

All rects in `uia.json`, `ocr.json`, `meta.json` `window` and the expected targets in `cases.jsonl`
are **physical px relative to the monitor's top-left corner**. The agent only encodes JPEG, so the
frames are `.jpg` (the spec's `frame.png` was dropped).

## Capturing a fixture

Build the agent once (`npm run build:native`), open the app on the screen you want with **demo
data**, then run from a terminal:

```
npm run capture:fixture -- --app gmail --name inbox --query "write a new email"
```

During the 5 s countdown (`--delay N` to change it), click the target window so it is in front.
The tool starts `native/target/release/lumen-native.exe`, captures that window's monitor, runs OCR
and a UIA snapshot, writes `fixtures/gmail/inbox/` and, with `--query`, lists the UIA elements that
match the request with their ids.

Options: `--max-nodes N` (default 400, like the app), `--all-nodes` (keep non-interactive nodes),
`--no-ocr`, `--no-redact`, `--theme dark|light`, `--locale`, `--app-version`, `--force` (overwrite
an existing fixture), `--exe <path>`. `npm run capture:fixture -- --help` lists them.

## Adding a case

```
npm run capture:fixture -- case --fixture gmail/inbox --query "write a new email"
npm run capture:fixture -- case --fixture gmail/inbox --query "write a new email" --expect e12 --append
```

Without `--expect` / `--rect` it prints the candidates and a line that is not ready yet. Pick the
right element id(s) with `--expect e12,e13`, or type a rect read off `frame.jpg` with
`--rect x,y,w,h` (several with `;`) for targets UIA cannot see (canvas). `--none` makes a negative
case. Other fields: `--intent click|locate|type-into|hover`, `--category
text-label|icon-only|ordinal|spatial|canvas|ambiguous`, `--uia good|partial|none`,
`--difficulty 1-3`, `--notes`, `--id`. `--append` adds the line to `cases.jsonl` only when it is
complete and its id is new; otherwise it is only printed.

Each case gets a `modelTarget` (the first picked element, else the first rect in 1280 image px):
the offline stand-in for the model's answer. `test/eval/grounding.test.ts` expects the `auto`
strategy to hit every case, so run `npm test -- test/eval` (or `npm run eval:grounding`) after
adding cases.

## Rules before committing a fixture

- Demo accounts and demo data only. No real inbox, chats, names, tabs, bookmarks or notifications.
- Open `frame.jpg` and `frame_1280.jpg` and look at every part of the image. **Images are never
  masked.** Delete the folder if anything private shows, and capture again.
- Text in `uia.json`, `ocr.json` and the window title is masked for emails (not `example.com`),
  API-key / token shaped strings and card numbers. That is a safety net, not a review: names,
  subjects and message text stay as captured. `--no-redact` turns the masking off.
- Keep fixtures small: one monitor per fixture, prefer a 1920 x 1080 or smaller screen, and
  remove captures that are not used by a case.
