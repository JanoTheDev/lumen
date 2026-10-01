# Adobe Photoshop

## What this app is for

Photoshop edits raster images: photos, scans and digital paintings. Work is built up in stacked layers so changes can be undone, hidden or adjusted later.

## Layout

Default "Essentials" workspace on a 1920x1080 window. Custom workspaces, floating panels or a different screen size break `regions.json`; fall back to OCR or vision.

- **Menu bar** (`menu-bar`): top edge. File, Edit, Image, Layer, Type, Select, Filter, 3D, View, Plugins, Window, Help.
- **Options bar** (`options-bar`): strip under the menu bar. Settings for the current tool (crop ratio, brush size, feather).
- **Toolbar** (`toolbar`): narrow column on the far left. One icon per tool group; a small triangle means more tools hide behind it (right-click to see them).
- **Document tabs** (`document-tabs`): above the canvas, one tab per open image. The tab shows name, zoom and color mode.
- **Canvas** (`canvas`): the image in the middle.
- **Contextual Task Bar**: a small floating bar near the canvas that suggests next actions. It moves around, so never point at it by region.
- **Properties / Adjustments panels** (`properties-panel`): upper right. Settings for the selected layer or adjustment.
- **Layers panel** (`layers-panel`): lower right. The layer stack; top of the list is the front of the image.
- **Layers panel buttons** (`layers-buttons`): icon row at the bottom of the Layers panel (link, effects, add mask, adjustment, group, new layer, delete).
- **Status bar** (`status-bar`): bottom of the document window. Zoom percent and document size.

## Modes / states

- **Active tool**: highlighted in the toolbar; the options bar changes with it.
- **Active layer**: highlighted row in the Layers panel. Most commands act on it only.
- **Mask editing**: when a layer mask thumbnail has a white frame, painting changes the mask, not the pixels.
- **Quick Mask** (Q): the selection is shown as a red overlay; press Q again to leave.
- **Modal dialogs** (Image Size, Export As) block the canvas until OK or Cancel. Their window title is the dialog name.

## Core concepts

- **Layer**: a sheet stacked over others. Hide with the eye icon.
- **Background layer**: the locked bottom layer of a new photo.
- **Adjustment layer**: a non-destructive color or tone change that affects layers below it.
- **Selection**: the marching-ants outline that limits where edits happen.
- **Layer mask**: grayscale map on a layer. White shows, black hides, gray is partly see-through.
- **Image Size vs Canvas Size**: Image Size resamples the picture; Canvas Size adds or trims space around it.
- **PSD vs export**: Save keeps layers in a PSD; Export makes a flat JPG, PNG or WebP for sharing.
- **History**: Control Z steps back through many changes; the History panel lists them.

## Gotchas for beginners

- Edits go to the active layer. If nothing seems to happen, check which layer is highlighted and whether it is hidden or locked.
- Painting or filling while a selection exists only affects inside the selection. Control D clears it.
- A crop is not applied until you press Enter or click the check mark in the options bar.
- With "Delete Cropped Pixels" off, cropped areas are only hidden.
- Generative features (Generative Fill, AI tools) need an Adobe account, an internet connection and use credits.

## Accessibility notes

- UIA exposure is partial: the menu bar, menus and most modal dialogs are reachable; panels, toolbar and canvas are custom-drawn.
- Prefer keyboard shortcuts and menu paths for voice users; every lesson step has one.
- Alt opens the menu bar by keyboard. Tab hides and shows all panels.
- Dialog fields (Width, Height) accept typed values, which is easier than dragging sliders.
