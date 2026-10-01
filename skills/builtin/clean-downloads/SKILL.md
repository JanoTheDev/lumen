---
name: clean-downloads
description: Sorts the Downloads folder into subfolders by file type, after showing the plan and getting an OK.
when_to_use: The user asks to clean up, tidy or sort their Downloads folder.
version: 1.0.0
author: Lumen
triggers: ['clean my downloads', 'clean up my downloads', 'tidy my downloads', 'sort my downloads']
permissions:
  files: { read: ['~/Downloads'], write: ['~/Downloads'] }
  risky: true
---

1. List the files directly in ~/Downloads (not in subfolders).
2. Group them with the table in reference/categories.md. Files you cannot place go to "Other".
3. Tell the user the plan, one short sentence per folder ("12 pictures to Images, 3 installers to Installers"), and ask_user "Shall I move them?".
4. Only after a yes: move each file into its folder inside ~/Downloads, creating the folder when missing. Never delete or rename anything; when a name is already taken, leave that file where it is.
5. Finish with how many files moved and which ones stayed.
