---
name: export-for-youtube
description: Exports the open video project as a YouTube-ready MP4 (H.264, 1080p or 4K) from DaVinci Resolve or Blender.
when_to_use: The user asks to export, render or make a YouTube version of their edit or animation.
version: 1.0.0
author: Lumen
apps: [davinci-resolve, blender]
triggers: ['export for youtube', 'make a youtube version', 'render for youtube']
params:
  resolution: { type: string, default: 1080p, enum: [1080p, 4k], description: Output size }
permissions:
  input: true
  files: { write: ['~/Videos'] }
tools: [observe, act, keys, wait_for, ask_user, finish]
---

1. Observe the screen and check which app is in front. Follow reference/resolve.md for DaVinci Resolve or reference/blender.md for Blender. Any other app: say this skill only knows those two and finish.
2. Export at {resolution} into the user's Videos folder, named after the project.
3. Before the render starts, say the file name and size and ask_user "Start the export?".
4. Start it, wait_for the progress to finish (renders can take long; tell the user they can keep working), then finish with where the file is.
