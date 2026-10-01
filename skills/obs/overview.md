# OBS Studio

## What this app is for

OBS Studio records your screen, camera and microphone to a video file, or sends the same picture live to a streaming site. You build what viewers see out of scenes and sources, then press one button to record or stream.

## Layout

Default layout on a fresh install, measured on a 1920 by 1080 window. Docks can be moved, closed or floated, and a custom layout breaks `regions.json`; fall back to text or vision when a region looks wrong.

- **Menu bar** (`menu-bar`, top edge): File, Edit, View, Docks, Profile, Scene Collection, Tools, Help.
- **Preview** (`preview`, the large area under the menu): shows exactly what will be recorded or streamed.
- **Scenes dock** (`scenes-dock`, bottom row, far left): list of scenes, with plus, minus and arrow buttons along its bottom edge.
- **Sources dock** (`sources-dock`, bottom row, second from left): the layers inside the current scene. Top of the list is drawn on top. The plus button at its bottom edge adds a source.
- **Audio Mixer** (`audio-mixer`, bottom row, middle): one meter and fader per audio source, usually Desktop Audio and Mic/Aux.
- **Scene Transitions** (`scene-transitions`, bottom row, right of the mixer): Fade or Cut, and the transition length.
- **Controls dock** (`controls-dock`, bottom row, far right): Start Streaming, Start Recording, Start Virtual Camera, Studio Mode, Settings, Exit.
- **Status bar** (`status-bar`, bottom edge): recording and streaming timers, CPU use and frame rate.

## Modes

- **Normal mode**: clicking a scene changes the live output at once.
- **Studio Mode** (Controls dock button): two previews side by side; you edit on the left and press Transition to send it live. The window looks split in two when it is on.
- **Recording / Streaming**: the button text changes to Stop Recording or Stop Streaming and a timer runs in the status bar. The window title does not change.

## Core concepts

- **Scene**: a saved layout of sources, like a camera angle you can switch to.
- **Source**: one input inside a scene, such as Display Capture, Window Capture, Video Capture Device or Audio Input Capture.
- **Profile**: a set of output settings (paths, encoders, stream key). **Scene collection**: a set of scenes.
- **Recording Path** and **Recording Format** live in Settings, Output. New profiles in OBS 32 default to Hybrid MP4, which survives a crash like MKV does. Older versions defaulted to MKV, which can be converted with File, Remux Recordings.
- **Encoder**: the part that compresses video. Hardware encoders (NVIDIA NVENC, AMD, Intel QuickSync) put less load on the processor.
- **Hotkeys** are empty by default. Set them in Settings, Hotkeys.
- **Auto-Configuration Wizard** (Tools menu) picks sensible resolution and bitrate settings.

## Gotchas for beginners

- A black Display Capture on laptops with two graphics chips usually means OBS runs on the wrong GPU; Windows Graphics settings fixes it.
- If a source is hidden behind another one, reorder it in the Sources dock; the eye icon hides a source without deleting it.
- Settings changes only apply after OK or Apply.
- Recording does not start automatically when you open OBS; the Start Recording button must be pressed.
- Desktop Audio and Mic/Aux are global audio sources, so they appear in the mixer for every scene.

## Accessibility notes

- Menus, the Settings dialog, source property dialogs and the Controls dock buttons are reachable with the keyboard and exposed to UI Automation with names.
- Tab moves between docks; arrow keys move inside the Scenes and Sources lists; the context menu key opens a list item's menu.
- The plus buttons in the Scenes and Sources docks are icon only. Right clicking empty space in the dock gives the same Add menu with readable text.
- The preview canvas is mouse only. Use source properties (right click a source, Transform, Edit Transform) to set position and size by number.
- Assigning hotkeys for Start Recording and Stop Recording in Settings, Hotkeys gives a voice or switch user a one key path.
- With the WebSocket server on, recording state and scenes can be checked exactly without looking at the screen.
