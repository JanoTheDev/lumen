# GIMP

## What this app is for

GIMP is a free, open-source image editor for photo retouching, image composition and simple drawing. Like Photoshop it works with layers, selections and masks, but its menus and names differ.

## Layout

Default single-window mode in GIMP 3.x on a 1920x1080 window. Multi-window mode, moved docks or a different screen size break `regions.json`; fall back to OCR or vision.

- **Menu bar** (`menu-bar`): top edge. File, Edit, Select, View, Image, Layer, Colors, Tools, Filters, Windows, Help.
- **Toolbox** (`toolbox`): upper left. Tool icons, grouped; click and hold a group to see the other tools in it.
- **Tool Options** (`tool-options`): lower left, under the toolbox. Settings for the active tool.
- **Image tabs** (`image-tabs`): above the canvas when more than one image is open.
- **Canvas** (`canvas`): the image in the middle, with rulers along the top and left.
- **Upper right dock** (`right-dock-top`): Brushes, Patterns, Fonts and Document History tabs.
- **Layers dock** (`layers-dock`): lower right, with tabs for Layers, Channels and Paths.
- **Layers buttons** (`layers-buttons`): icon row at the bottom of the Layers tab (new layer, group, move up and down, duplicate, mask, delete).
- **Status bar** (`status-bar`): bottom of the canvas. Pointer position, units, zoom and hints.

## Modes / states

- **Active tool**: highlighted in the toolbox; Tool Options shows its settings.
- **Active layer**: highlighted row in the Layers tab.
- **Mask editing**: when a layer mask thumbnail has a white frame, painting edits the mask.
- **Quick Mask** (Shift Q): selection shown as a red overlay.
- **Window title** shows the file name, color mode, layer count and pixel size, for example "photo.jpg-1.0 (RGB color 8-bit, 1 layer) 1920x1080 – GIMP". Useful to confirm size and layer changes.
- **Dialogs** (Scale Image, Brightness-Contrast, Export Image) open as separate windows titled with their name.

## Core concepts

- **XCF**: GIMP's own format; Save and Save As only write XCF.
- **Export As**: the way to write JPG, PNG or WebP. Export does not keep layers.
- **Layer**: a sheet in the stack; top of the list is in front.
- **Alpha channel**: transparency; a layer needs one before erasing shows see-through areas.
- **Selection**: marching-ants outline that limits edits.
- **Layer mask**: white shows, black hides, gray partly hides.
- **Scale Image vs Canvas Size**: scaling resamples pixels; Canvas Size changes only the border.
- **Floating selection**: a temporary pasted layer that must be anchored or turned into a new layer.

## Gotchas for beginners

- Save only makes XCF. To get a JPG or PNG use File > Export As.
- Opening a JPG and pressing Control S does not overwrite it; it asks for an XCF name.
- Edits apply to the active layer only. If nothing happens, check the highlighted layer and any selection (Select > None clears it).
- The crop is applied only after Enter or a click inside the crop rectangle.
- Many filters and color tools are previewed live on the canvas until you click OK.

## Accessibility notes

- UIA exposure on Windows is weak (GTK). Expect the window title and possibly some dialogs, not individual tools or layers.
- Prefer keyboard shortcuts and menu paths. Alt plus the underlined letter opens menus.
- Dialog fields accept typed numbers; Tab moves between them.
- Tab hides and shows the docks for a larger canvas.
- The window title (layer count, size) is the most reliable cheap check.
