# Sources and version assumptions

Checked on 2026-10-01 against the GIMP 3.0 user manual; the latest release seen was GIMP 3.2.x. Content written in our own words.

## Official

- GIMP 3.0 manual: https://docs.gimp.org/3.0/en/
- Export As (Shift Ctrl E): https://docs.gimp.org/3.0/en/gimp-file-export-as.html
- Save As (Shift Ctrl S): https://docs.gimp.org/3.0/en/gimp-file-save-as.html
- Scale Image: https://docs.gimp.org/3.0/en/gimp-image-scale.html
- Crop tool (Shift C, Enter to apply): https://docs.gimp.org/3.0/en/gimp-tool-crop.html
- Brightness-Contrast: https://docs.gimp.org/3.0/en/gimp-tool-brightness-contrast.html
- Add Layer Mask: https://docs.gimp.org/3.0/en/gimp-layer-mask-add.html
- Single-window layout: https://docs.gimp.org/3.0/en/gimp-concepts-main-windows.html
- Windows downloads: https://download.gimp.org/gimp/v3.2/windows/

## Version assumptions

- Lessons target GIMP 3.0 and later (`appVersion: ">=3.0"`). GIMP 2.10 is matched so the overview still helps, but some menu labels differ there.
- Process names: GIMP 3 on Windows installs `gimp-3.exe` (plus versioned copies such as `gimp-3.0.exe` / `gimp-3.2.exe`); 2.10 uses `gimp-2.10.exe`.
- Default window title format (file name, layer count, pixel size, "– GIMP"). Users can change it in Preferences > Image Windows > Title and Status, which breaks the window-title checks; vision checks are the fallback.

## Unverified

- Tool shortcuts in `shortcuts.md` come from the default shortcut set as known for 2.10/3.0; not every one was rechecked against the 3.2 Keyboard Shortcuts dialog.
- `regions.json` values are estimates for single-window mode on 1920x1080.
- UIA quality "none" is an estimate (GTK on Windows exposes little). Confirm with Accessibility Insights.
- Dialog window titles ("Scale Image", "Brightness-Contrast", "Export Image") are assumed from the manual.
