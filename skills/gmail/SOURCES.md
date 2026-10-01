# Sources and assumptions — Gmail pack

Checked on 2026-10-01. Wording in this pack is original.

## Consulted

- Keyboard shortcuts for Gmail (Google Help, answer 6594): https://support.google.com/mail/answer/6594 (fetched 2026-10-01). Shortcuts are off by default and turned on under Settings > See all settings > Keyboard shortcuts; Ctrl+Enter sends; c, /, r, a, f, e, #, !, Shift+i, Shift+u, z, x, j, k, o, u, g then i, Ctrl+Shift+c and Ctrl+Shift+b as listed in shortcuts.md.

## Version assumptions

- Gmail web as of September 2026 in Chrome, Edge or Firefox. The tab title contains "Gmail"; the window title is the tab title plus the browser name.
- Accessible names: "Compose", "Search mail", "To recipients", "Subject", "Message Body", "Send", "Attach files", "Discard draft", "Archive", "Delete", "Mark as read", "Reply", "Reply all", "Forward". Gmail appends shortcut hints to some names, for example "Send (Ctrl-Enter)", so match on the start of the name.

## Not verified on a real machine

- The accessible names and roles above; the synthetic fixtures in eval/grounding/fixtures/gmail use them.
- regions.json fractions (estimates; there is no reading-pane layout region, since the open email replaces the list by default).
- Whether a browser exposes the message list as a grid of rows or as a list; plans read row names, not roles.
