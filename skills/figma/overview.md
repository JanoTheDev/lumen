# Figma Design

## What this app is for

Figma is a collaborative design tool for app screens, websites and graphics. It runs in the browser or as a desktop app, and several people can edit one file at the same time.

## Layout

Current UI (UI3) in the desktop app on a 1920x1080 window. In a browser the tab and address bar push everything down; a resized window, hidden panels (Control backslash) or zoomed browser breaks `regions.json`, so fall back to OCR or vision.

- **File tabs** (`file-tabs`): top strip of the desktop app, one tab per open file. Not present in the browser.
- **Left sidebar** (`left-sidebar`): File and Assets tabs. The File tab lists Pages, then Layers.
- **Layers list** (`layers-list`): lower part of the left sidebar. Every frame and shape, nested by parent.
- **Canvas** (`canvas`): the infinite work area in the middle.
- **Toolbar** (`toolbar`): floating bar at the bottom center of the canvas. Move, Frame, Shape, Pen, Text, Comment, plus Dev Mode and actions.
- **Right sidebar header** (`right-header`): avatars, the Present (play) button and Share.
- **Right sidebar tabs** (`right-tabs`): Design and Prototype tabs, under the header.
- **Right sidebar** (`right-sidebar`): properties of the selection: position, size, auto layout, fill, stroke, effects, export (Design tab) or interactions (Prototype tab).
- **Zoom menu**: zoom percentage in the right sidebar header.

## Modes / states

- **Design vs Prototype tab**: which tab in the right sidebar is underlined. Shift E switches.
- **Selection**: the selected layer is highlighted in the layers list and has a blue box with handles on the canvas.
- **Text editing**: a blinking cursor in a text layer; Escape leaves it.
- **Dev Mode**: toggle in the toolbar; shows code and specs instead of editing tools. Lessons assume it is off.
- **Present / preview**: opens the prototype player in a new tab or window; Escape or closing it returns.
- Window title (desktop) or tab title (browser) ends with "– Figma" and starts with the file name.

## Core concepts

- **Frame**: a container, usually a screen or artboard. Frames can hold other frames.
- **Layer**: anything on the canvas: frame, shape, text, image, group.
- **Auto layout**: a frame setting that stacks its children in a row or column with fixed gap and padding, and resizes to fit.
- **Component**: a reusable main design. Edits flow to every copy.
- **Instance**: a linked copy of a component.
- **Prototype connection**: an arrow from a layer to a destination frame with a trigger (On click) and an action (Navigate to).
- **Export settings**: per-layer formats and scales (PNG, JPG, SVG, PDF; 1x, 2x).

## Gotchas for beginners

- Single-letter shortcuts only work when the canvas has focus, not while typing in a text layer or a field.
- Shapes drawn inside a frame become its children; drawn outside, they float on the canvas.
- Shift A on a selection wraps it in a new auto layout frame; on a frame it adds auto layout to that frame.
- Editing an instance changes only that copy; edit the main component (purple diamond icon) to change all.
- Export uses what is selected; with nothing selected, Control Shift E exports every layer that has export settings.
- View-only files hide editing tools; duplicate the file to your drafts to practice.

## Accessibility notes

- UIA exposure is partial: the browser or Electron accessibility tree exposes many toolbar buttons, sidebar fields and menus; the canvas itself is a drawing surface with no per-layer nodes.
- Figma supports keyboard navigation of the layers list and canvas (Control Shift question mark lists shortcuts).
- Prefer shortcuts for tools (F, R, O, T, Shift A) and named sidebar fields for values.
- The Present button and Share are reachable as named buttons in the right sidebar header.
