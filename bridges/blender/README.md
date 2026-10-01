# Lumen Bridge for Blender

A small add-on that lets Lumen's Blender lessons check each step exactly (mode, selection,
workspace, last operator, material colour …) instead of guessing from screenshots.

- Listens on `127.0.0.1:47651` only, on a background thread. All `bpy` reads happen on
  Blender's main thread through a 0.1 s `bpy.app.timers` callback.
- Read-only: the commands are `ping`, `state` and `object {name}`. It never runs code it is sent.
- Every request must carry the token Lumen writes to `%APPDATA%\Lumen\blender-bridge.token`.
- Blender 4.2+ (extension, `blender_manifest.toml`) and 3.6 LTS (legacy `bl_info`).

## Install

1. Lumen: Settings → App helpers → Show the add-on file (saves `lumen_bridge.zip`).
2. Blender: Edit → Preferences → Get Extensions (Add-ons on 3.6) → menu → Install from Disk →
   pick `lumen_bridge.zip`, and make sure "Lumen Bridge" is enabled.
3. Lumen: click Test. It should say "Blender helper: Connected".

## Protocol

NDJSON, one request per line:

```json
{"id": 1, "token": "<64 hex>", "cmd": "state"}
{"id": 1, "ok": true, "result": {"mode": "OBJECT", "workspace": "Layout", "op_seq": 4, "operators": [...], ...}}
```

Errors come back as `{"id": 1, "ok": false, "error": "unauthorized"}`.

## Tests

The socket and protocol half (`server.py`) does not import `bpy`:

```bash
python -m unittest discover -s bridges/blender/tests
```
