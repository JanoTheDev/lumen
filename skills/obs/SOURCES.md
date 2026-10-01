# Sources and version assumptions — OBS Studio pack

Checked 2026-10-01 against official documentation. Wording in this pack is our own.

## Official references

- Quick Start Guide: https://obsproject.com/kb/quick-start-guide (docks, Sources plus button, Controls dock, Audio Mixer)
- Standard recording output guide: https://obsproject.com/kb/standard-recording-output-guide (Settings, Output, Recording Path, Recording Format, Remux)
- Sources guide: https://obsproject.com/kb/sources-guide
- Hotkeys: https://obsproject.com/kb/hotkeys-guide
- Hybrid MP4 background: https://obsproject.com/blog/obs-studio-hybrid-mp4
- obs-websocket v5 protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

## Version assumptions

- Lessons target OBS 30 or later (`appVersion: ">=30"`); content checked against the 32.2 release notes era.
- OBS 28+ ships obs-websocket v5 on port 4455; it is off until enabled under Tools, WebSocket Server Settings.
- Hybrid MP4 left beta and became the default container for new profiles in 32.0. Upgraded profiles keep their old format, often MKV.
- Windows input kind ids used in bridge checks: `monitor_capture` (Display Capture), `wasapi_input_capture` (Audio Input Capture).

## Bridge check convention

Bridge `expect` objects name the obs-websocket request and the field to compare, for example `{ "request": "GetRecordStatus", "outputActive": true }`. Fields ending in `Changed` mean "differs from the value captured when the step started". The bridge implementation (T24) owns this mapping.

## Unverified

- Accessible names of the icon-only plus buttons in the Scenes and Sources docks (assumed "Add"); lessons use the dock region and text fallbacks.
- UIA role names for OBS dock buttons and list items (assumed Button and ListItem).
- Built-in edit keys (Ctrl+E, Ctrl+R, Ctrl+F, Ctrl+S, Ctrl+D for transforms, F2 rename) are from the Edit menu of recent builds, not re-measured on 32.2.
- Region fractions are estimates of the reset dock layout, not pixel measurements.
