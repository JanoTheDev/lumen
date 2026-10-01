# Accessibility notes

## Using Lumen with other assistive tech

Lumen checks which assistive tech runs (at start and whenever it changes) and adjusts.

### Voice Access and Dragon

These apps listen all the time, so when you hold Lumen's hotkey they hear the same words.

- Commands both apps understand (numbers, mouse grid, clicking, scrolling, keys, typing, opening apps, window commands) are left to Voice Access or Dragon. Lumen shows "Voice Access handles that".
- Start with "Lumen" to have Lumen do it instead: "Lumen, show numbers", "Lumen scroll down".
- Once Lumen's own numbers or grid are on screen, "click 5", "3" and so on go to Lumen without the prefix, because the other app has no such numbers.
- Commands only Lumen has always work: "describe screen", "read this", "what can I say", "pin", "pause dwell".
- While Dragon runs, Lumen's wake word is off, since Dragon owns the microphone. The hotkey still works.
- Settings: `a11y.coexist.yieldToVoiceControl` (default on) and `a11y.coexist.wakeWithDragon` (default off) in `~/.ai-overlay/config.json`.
- Keys these tools use (Voice Access Alt+Shift+B, Narrator Ctrl+Win+Enter, NVDA Ctrl+Alt+N, Win+H, Magnifier) cannot be given to Lumen's accessibility shortcuts. Settings → Accessibility shows them as a clash.

### NVDA, JAWS and Narrator

With a screen reader running, Lumen speaks through it instead of its own voice. Answers are read once, and Lumen's status lines go to the screen reader too. No setup is needed.

## Describe and read

- "describe screen" / "what's on my screen": a short description. Then say "more detail" for the full one.
- "what's under my cursor" / "what is this button": explains the control under the pointer.
- "read this" / "read the selection": the selected text. With nothing selected it reads the field that has focus, then the text under the pointer.
- "read the page": the whole document (browser page, PDF in Edge, Word), in parts. Say "pause", "continue", "next", "repeat" or "stop". Pressing the hotkey pauses the reading too.
- Password fields are never read.
- Reading uses your screen reader, or Lumen's voice when spoken replies are on. With neither, the text is shown in the bar.

## Eye gaze and head pointers

Eye trackers (Windows Eye Control, Tobii) and head pointers move the normal Windows pointer, so Lumen's dwell click, palette and snapping work with them without extra drivers.

Settings → Accessibility → Moving: dwell click → **Set up for eye gaze or head pointer** sets:

- rest time at least 1.2 s
- allowed wobble 30 px
- pointer smoothing 50%
- snap to the nearest button
- extra large ring and the click-type palette

The "Eye gaze" profile in onboarding sets the same, plus a larger interface.

Tips:

- If clicks fire too early, raise the rest time first, then the smoothing.
- If the ring keeps restarting, raise the allowed wobble.
- Rest in the top-left corner (configurable) to pause dwell, or say "pause dwell".

## Simple mode

Settings → Accessibility → Simple mode: Lumen's own messages use fewer, plainer words, and the Accessibility settings show only the main options ("Show all options" brings the rest back).
