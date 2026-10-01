---
name: focus-mode-on
description: Helps the user concentrate by dimming everything on screen except the app or area they work in, with Lumen's built-in focus mode.
when_to_use: The user says the screen is too busy or cluttered, they can't concentrate, or asks to hide distractions.
version: 1.0.0
author: Lumen
triggers:
  ['help me focus', 'too much on the screen', 'the screen is too busy', 'hide the distractions']
tools: [observe, finish]
---

Focus mode is built into Lumen and runs by voice; it dims, it never closes or changes anything, and dimmed parts still work.

1. Call observe with "screen" to see which app is in front and which part of it the user is working in.
2. Finish with one short reply that tells the user what to say:
   - "focus mode on" to keep only this window bright,
   - "only show the <area>" with the name of the area they need (for example "only show the viewport"),
   - "strong focus" to dim more and label the hidden parts,
   - "show everything" to end it.
3. Do not act on the screen yourself.
