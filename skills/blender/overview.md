# Blender

## What this app is for

Blender is a free, all-in-one 3D program: you build objects, give them materials, light them and render still images or animations. Everything happens inside one window that is split into editors.

## Layout (default "Layout" workspace)

- **Top bar** (`top-menus`, `workspace-tabs`): menus File, Edit, Render, Window, Help on the far left, then the workspace tabs (Layout, Modeling, Sculpting, Shading, and more).
- **3D Viewport** (`3d-viewport`): the big area in the middle where the scene is shown and edited.
  - **Header** (`viewport-header`): strip along its top with the mode selector (Object Mode, Edit Mode), View/Select/Add/Object menus and, at its right end, the viewport shading buttons.
  - **Toolbar** (`toolbar`): column of tool icons on the left edge. Toggle with T.
  - **Sidebar** (`sidebar`): panel on the right edge with Item, Tool and View tabs. Hidden by default; toggle with N.
  - **Navigation gizmo** (`navigation-gizmo`): the colored axis ball in the top right corner of the viewport, with zoom, pan, camera and perspective buttons below it.
- **Outliner** (`outliner`): top right. A tree of everything in the scene (Collection, Camera, Cube, Light).
- **Properties editor** (`properties`): bottom right. A vertical column of tabs (`properties-tabs`) on its left edge switches between Render, Output, Scene, Object, Modifiers, Material and others.
- **Timeline** (`timeline`): strip along the bottom for playback and keyframes.
- **Status bar** (`status-bar`): very bottom. Shows what the mouse buttons do right now and scene statistics.

Regions are measured for a maximized window with the default Layout workspace. Custom layouts, other workspaces or a maximized area (Control Space) break them; fall back to OCR or vision.

## Modes

- **Object Mode**: move, rotate and scale whole objects. The mode selector in the viewport header reads "Object Mode".
- **Edit Mode**: change the shape of one mesh (vertices, edges, faces). Header reads "Edit Mode" and the vertex/edge/face buttons appear next to it. Tab toggles between the two.
- Other modes (Sculpt, Texture Paint, Weight Paint, Pose) are picked from the same selector.
- The window title shows the file name and Blender version; it does not show the mode.

## Core concepts

- **Object**: anything in the scene (mesh, camera, light). Has a location, rotation and scale.
- **Mesh**: an object made of vertices, edges and faces.
- **Active vs selected**: the active object has a light orange outline, other selected objects a darker orange one. Most tools act on the active object.
- **3D cursor**: the red and white ring. New objects appear there.
- **Transform**: G moves, R rotates, S scales. Then X, Y or Z locks an axis, a typed number sets the amount, Enter or left click confirms, Escape or right click cancels.
- **Material**: how a surface looks. New materials use the Principled BSDF shader; Base Color sets its main color.
- **Viewport shading**: Wireframe, Solid, Material Preview, Rendered. Z opens a pie menu to switch.
- **Render**: F12 renders a still image from the active camera into a separate Blender Render window. Still renders are not saved automatically.

## Gotchas for beginners

- Shortcuts act on the editor **under the mouse pointer**, not the one you last clicked. Keep the pointer over the 3D Viewport before pressing a viewport key.
- Numpad keys are not the number row. On the number row in Edit Mode, 1, 2 and 3 pick vertex, edge and face select. Since Blender 5.0, the number row no longer toggles collections in the viewport.
- On a laptop without a numpad or middle button, use the navigation gizmo, or turn on Emulate Numpad and Emulate 3 Button Mouse in Edit, Preferences, Input.
- A transform stays active until you click or press Enter. Moving the mouse keeps changing it.
- The default startup cube already has a material, so the Material tab shows it instead of a New button.
- Control Z undoes almost everything. F9 reopens the settings of the last operation.

## Accessibility notes

- No UI Automation tree: buttons, panels and menus are invisible to screen readers. Only the main window title is exposed.
- Almost every action has a keyboard shortcut; prefer shortcuts for voice and switch users.
- F3 opens Menu Search: type an operation name and press Enter. This is the most voice-friendly way to reach any command.
- Middle-mouse navigation can be replaced by the navigation gizmo, numpad views and the Emulate options above.
- Resolution Scale in Preferences, Interface makes all text and buttons larger.
