# Adobe Premiere

## What this app is for

Premiere is Adobe's video editor for cutting footage, adding text, music and effects, and exporting finished videos. It was called Premiere Pro until version 26 in 2026; the tools are the same.

## Layout

Default **Editing** workspace:

- **Menu bar** (`menu-bar`) — File, Edit, Clip, Sequence, Markers, Graphics and Titles, View, Window, Help.
- **Header bar** (`header-bar`) — mode tabs (Import, Edit, Export) on the left, the project name in the middle, workspaces and quick export on the right.
- **Source Monitor** (`source-monitor`) — top left; previews a clip before it goes on the timeline. Effect Controls and other panels share this frame as tabs.
- **Program Monitor** (`program-monitor`) — top right; shows the sequence at the playhead. This is where text is typed and positioned.
- **Project panel** (`project-panel`) — bottom left; lists imported media and sequences. Media Browser and Effects share this frame as tabs.
- **Tools panel** (`tools-panel`) — thin strip between Project panel and Timeline with Selection, Razor, Type and other tools.
- **Timeline** (`timeline`) — bottom right; the sequence with video tracks (V1, V2…) above audio tracks (A1, A2…).
- **Audio meters** (`audio-meters`) — narrow strip at the far right of the Timeline.
- **Properties panel** — opened from the Window menu; styles text and adjusts the selected clip.

Regions are measured on the default Editing workspace. A different workspace, moved panels or a small window break them; then point by visible text or a screenshot. Window, Workspaces, Reset to Saved Layout restores the default.

## Modes / pages

- **Import mode** — choose files and create a project or sequence.
- **Edit mode** — the normal editing workspace with all panels.
- **Export mode** — export settings, a preview and the Export button. Opened with Control M.

The active mode tab in the header bar is highlighted. The window title shows the app name and the project file path ending in .prproj.

## Core concepts

- **Project** — a .prproj file that remembers your media links, sequences and edits. Media files stay where they are.
- **Sequence** — a timeline with its own size and frame rate; dragging a clip into an empty Timeline creates one that matches.
- **Playhead** — the blue line with a handle showing the current frame.
- **Track** — one row of the Timeline; higher video tracks appear on top.
- **Clip** — a piece of media placed on the Timeline.
- **Edit point** — where one clip ends and the next begins.
- **Graphic clip** — a text or shape layer on a video track.
- **Export preset** — saved settings such as Match Source with H.264.

## Gotchas for beginners

- Shortcuts act on the panel that has focus (blue outline). Click the Timeline before pressing editing keys.
- The Razor tool stays active until you press V; clicking with it keeps cutting.
- Plain Delete leaves a gap; Shift Delete is a ripple delete that closes it.
- Since version 25 there is no Essential Graphics editing panel; text styling lives in the Properties panel.
- Moving or renaming media files makes clips go offline.
- Auto-save is on, but save with Control S anyway.

## Accessibility notes

- Menus, dialogs and the Export settings are mostly reachable with the keyboard and Alt key navigation; the Timeline and monitors are mouse driven and poorly exposed to screen readers.
- Almost every command has a shortcut, and Edit, Keyboard Shortcuts (Control Alt K) remaps them. Prefer shortcuts for voice and switch users.
- Audio Gain (G) and Speed/Duration (Control R) are dialogs with typed numbers, which suit voice input better than dragging.
