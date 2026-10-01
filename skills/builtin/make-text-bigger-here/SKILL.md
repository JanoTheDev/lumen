---
name: make-text-bigger-here
description: Makes text bigger in the app in front with its own zoom, or for all of Windows when the user wants that.
when_to_use: The user says text is too small, or asks to zoom in or make things bigger.
version: 1.0.0
author: Lumen
triggers: ['make the text bigger', 'make text bigger here', 'the text is too small', 'zoom in here']
params:
  steps: { type: number, default: 2, description: How many zoom steps }
permissions:
  input: true
tools: [observe, keys, launch_app, act, ask_user, finish]
---

1. Observe which app is in front. Look up its zoom keys in reference/zoom-keys.md.
2. Press the zoom-in keys {steps} times, then observe once to check the text got bigger.
3. If the app has no zoom, ask_user "Make text bigger for all of Windows?". Only after a yes: open Settings, Accessibility, Text size, move the slider up one notch and press Apply.
4. Finish with how to undo it ("Say make the text smaller, or press Ctrl and 0").
