# Sources and assumptions — Outlook (classic) pack

Checked on 2026-10-01. Wording in this pack is original.

## Consulted

- Keyboard shortcuts for Outlook (Microsoft Support, classic Outlook tab): https://support.microsoft.com/en-us/office/keyboard-shortcuts-for-outlook-3cdeb221-7ae5-4c1d-8c1d-9e63216c1efd (fetched 2026-10-01). Ctrl+Shift+M, Ctrl+R, Ctrl+Shift+R, Ctrl+F, Alt+S, Ctrl+Enter, Ctrl+E or F3, Ctrl+O, Ctrl+Q, Ctrl+U, Ctrl+Shift+G, Ctrl+Shift+V, Alt+H D, Shift+Delete, Ctrl+Shift+I, Ctrl+1, Ctrl+K, Ctrl+Shift+B, Ctrl+M or F9.
- Secondary (not on that page, 2026-10-01): Ctrl+D to delete and Backspace to archive, from common Outlook shortcut lists such as https://defkey.com/outlook-on-the-web-and-outlook-com-shortcuts. Marked "Secondary".

## Version assumptions

- Classic Outlook for Microsoft 365 (version 16.0) on Windows 11, classic ribbon.
- Ctrl+Enter sends only after the user agreed once to Outlook's "use Ctrl+Enter to send" prompt; Alt+S always sends.
- Accessible names: "New Email", "Delete", "Archive", "Reply", "Reply All", "Forward", "Search", "To", "Cc", "Subject", "Send", "Attach File"; message list rows are table rows whose name lists From, Subject and Received.

## Not verified on a real machine

- The accessible names above; the synthetic fixtures in eval/grounding/fixtures/outlook-classic use them.
- regions.json fractions (estimates).
