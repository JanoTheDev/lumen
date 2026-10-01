# Visual Studio Code

## What this app is for

VS Code is a free code editor for writing and running programs in almost any language. Most of its power comes from the Command Palette, a built-in terminal, Git support and extensions.

## Layout

Default layout, measured on a 1920 by 1080 window. Users often move or hide parts, and a custom layout breaks `regions.json`; fall back to UI Automation names or vision when a region looks wrong.

- **Title bar** (`title-bar`, top edge): the menu (File, Edit, Selection, View, Go, Run, Terminal, Help) on the left and the **Command Center** (`command-center`) search box in the middle.
- **Activity Bar** (`activity-bar`, thin strip at the far left): icons for Explorer, Search, Source Control, Run and Debug, Extensions. Clicking one changes the side bar.
- **Primary Side Bar** (`side-bar`, left of the editor): shows the view picked in the Activity Bar, such as the Explorer file tree.
- **Editor** (`editor`, the large middle area): open files as tabs along its top edge. It can be split into groups side by side.
- **Secondary Side Bar** (`secondary-side-bar`, right edge): holds the Chat view by default; may be closed.
- **Panel** (`panel`, under the editor): tabs for Problems, Output, Debug Console, Terminal and Ports.
- **Status Bar** (`status-bar`, bottom edge): current Git branch, errors and warnings count, line and column, language mode.

## Modes and states

- **No folder open**: the Explorer shows Open Folder and Clone Repository buttons; the window title reads like "Welcome - Visual Studio Code".
- **Folder open**: the title becomes "file - folder - Visual Studio Code" and the Explorer shows the folder tree.
- **Restricted Mode**: an untrusted folder; some features stay off until you trust the authors. A banner and status bar item show it.
- **Screen Reader Optimized**: shown in the Status Bar when accessibility support is on.
- **Zen Mode**: everything except the editor hidden; press Escape twice to leave.

## Core concepts

- **Command Palette** (Control Shift P): every command, searchable by name. Typing without the leading greater-than sign switches to file search.
- **Quick Open** (Control P): jump to any file in the folder by typing part of its name.
- **Workspace**: the folder or folders currently open; settings and search apply to it.
- **Extension**: an add-on for a language, theme or tool, installed from the Marketplace in the Extensions view.
- **Integrated terminal**: a command line inside VS Code that starts in the open folder.
- **Source Control**: Git changes listed by file; you stage changes, write a message and commit.
- **Settings**: a searchable editor (Control comma) with User and Workspace tabs.

## Gotchas for beginners

- Opening a single file is not the same as opening a folder; search, Git and many extensions need a folder.
- A single click opens a file in preview mode (italic tab title) which is replaced by the next file you click; double click to keep it.
- Unsaved files show a dot on the tab; Auto Save is off by default.
- The terminal runs real commands on your computer.
- A commit only saves to your computer; Sync or Push sends it to GitHub or another remote.

## Accessibility notes

- Nearly everything is keyboard reachable. F6 and Shift F6 move between the main parts; Alt F1 opens accessibility help for the focused part; Alt F2 opens the Accessible View for hovers, chat and notifications.
- With `editor.accessibilitySupport` on (or a screen reader detected), the editor is exposed line by line to UI Automation.
- Control M toggles whether Tab inserts a tab or moves focus.
- The Command Palette is the best voice-friendly path: open it, say or type the command name, press Enter.
- Activity Bar icons have no visible text, but their accessible names are the view names.
- Zoom with Control equals and Control minus; High Contrast themes are under File, Preferences, Theme.
