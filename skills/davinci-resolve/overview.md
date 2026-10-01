# DaVinci Resolve

## What this app is for

DaVinci Resolve is a free video editor from Blackmagic Design that also covers color grading, visual effects, audio mixing and export. The paid Studio edition adds extra effects, higher resolutions and scripting.

## Layout

Resolve is split into **pages**. Each page fills the whole window and has its own panels; the page buttons sit in a row along the bottom of the window (`page-bar`).

- **Menu bar** (`menu-bar`) — File, Edit, Trim, Timeline, Clip, Mark, View, Playback, Fusion, Color, Fairlight, Workspace, Help.
- **Interface toolbar** (`interface-toolbar`) — the row of panel buttons under the menu bar (Media Pool, Effects, Edit Index, Sound Library on the left; Mixer, Metadata, Inspector on the right). Clicking one shows or hides that panel.
- **Edit page**: Media Pool top left (`edit-media-pool`), Effects panel below or beside it when open (`edit-effects`), source viewer (`edit-source-viewer`), timeline viewer (`edit-timeline-viewer`), Inspector on the right (`edit-inspector`), timeline toolbar (`edit-toolbar`) and the timeline across the bottom (`edit-timeline`).
- **Color page**: Gallery top left, viewer top centre (`color-viewer`), Node editor top right (`color-nodes`), clip thumbnails strip in the middle (`color-clips`), Color Wheels bottom left (`color-wheels`), scopes or keyframes bottom right.
- **Deliver page**: Render Settings on the left (`deliver-render-settings`), viewer in the middle, Render Queue on the right (`deliver-render-queue`), timeline below.

Regions are measured on the default layout of each page. Rearranged panels, a dual-screen layout or a small window will break them; then point by visible text or a screenshot instead.

## Modes / pages

- **Media** — browse drives and bring clips into the Media Pool.
- **Cut** — fast editing with a simplified timeline.
- **Edit** — the classic editing timeline. Most beginner lessons happen here.
- **Fusion** — node-based effects and animated titles.
- **Color** — grading with nodes, wheels and curves.
- **Fairlight** — audio mixing.
- **Deliver** — export settings and the render queue.

How to tell the current page: the active page icon on the bottom bar is highlighted, and the panel layout changes. The window title shows the app and project name, not the page. Shift with a number key switches pages: Shift 2 Media, Shift 3 Cut, Shift 4 Edit, Shift 5 Fusion, Shift 6 Color, Shift 7 Fairlight, Shift 8 Deliver.

## Core concepts

- **Project** — holds your media, timelines and settings; managed in the Project Manager.
- **Media Pool** — the list of clips imported into this project. Importing does not copy files.
- **Timeline** — clips arranged in time on video tracks (V1, V2…) and audio tracks (A1, A2…).
- **Playhead** — the red vertical line marking the current frame.
- **Edit point** — the boundary between two clips; transitions sit on it.
- **Node** — one step of a color grade on the Color page. Nodes chain from left to right.
- **Lift, Gamma, Gain** — wheels that adjust shadows, midtones and highlights.
- **Render Queue** — export jobs wait here until you click Render All.

## Gotchas for beginners

- The same key does different things on different pages, and on the Edit page it acts on the panel that was last clicked.
- Add to Render Queue does not export anything; Render All starts it.
- Ripple delete closes the gap; a plain Delete leaves a gap.
- Text on the Edit page uses Text Plus (shown as "Text+") from the Titles section of the Effects panel.
- Color changes apply to the selected clip only, unless you copy the grade.
- Resolve saves projects in its own database, not as a file you pick; use File, Export Project to get a file.

## Accessibility notes

- Menus and many dialogs are reachable with Alt and the keyboard; panels, the timeline and color controls are mouse driven and mostly not exposed to screen readers.
- Nearly every editing command has a shortcut, and Keyboard Customization (Control Alt K) lets you remap them. Prefer shortcuts for voice and switch users.
- The free edition cannot be scripted from outside, so progress is checked by looking at the screen.
