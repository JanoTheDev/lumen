---
name: read-this-aloud
description: Reads the selected text, or the main text in the foreground window, out loud.
when_to_use: The user asks to read something aloud, read it to them, or read the screen.
version: 1.0.0
author: Lumen
triggers: ['read this aloud', 'read this to me', 'read it out loud', 'read the screen']
tools: [observe, finish]
---

1. Observe the screen. If text is highlighted, read that; otherwise take the main text (the article or message body, not menus or ads).
2. Reply with the text itself, word for word, in reading order. Do not summarize, comment or add anything.
3. If it is very long (more than about 500 words), read the first part and then say "Say continue for more".
