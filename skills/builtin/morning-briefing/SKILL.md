---
name: morning-briefing
description: Opens the user's calendar and mail and reads out today's events and the newest unread emails.
when_to_use: The user says good morning or asks what is on today, their schedule or their briefing.
version: 1.0.0
author: Lumen
triggers: ['morning', 'good morning', 'morning briefing', 'whats on today']
permissions:
  input: true
tools: [observe, launch_app, act, wait_for, finish]
---

1. Open the calendar (launch_app "Outlook" or "Calendar"). Observe today's view.
2. Read today's events in time order: time, title, place. No events: say "Your calendar is free today".
3. Open the mail and observe the inbox. Name at most 5 unread emails: sender and subject. Do not open them.
4. Finish with one spoken paragraph under 80 words. Leave both apps open.
