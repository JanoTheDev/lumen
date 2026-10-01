# Sources and version assumptions

Checked on 2026-10-01 against Photoshop 2026 (version 27.x, Windows). Content written in our own words.

## Official

- Photoshop on desktop release notes: https://helpx.adobe.com/photoshop/desktop/whats-new/photoshop-on-desktop-release-notes.html
- Default keyboard shortcuts: https://helpx.adobe.com/photoshop/using/default-keyboard-shortcuts.html
- Export settings and preferences: https://helpx.adobe.com/photoshop/desktop/save-and-export/export-files-to-different-formats/export-settings-and-export-location-preferences.html
- Resize an image: https://www.adobe.com/products/photoshop/resize-image.html

## Version assumptions

- Lessons target Photoshop 2025 (26.x) and later (`appVersion: ">=26"`). Menu paths used here (Image > Image Size, File > Export > Export As, Select > Subject, Layer > New Adjustment Layer) have been stable since 2021.
- Latest release seen while writing: 27.10 (August 2026).
- Default "Essentials" workspace, Windows, default keyboard shortcut set.

## Unverified

- `regions.json` values are estimates for the Essentials workspace on 1920x1080, not measured on a live install.
- UIA quality "partial" is an estimate (menus and dialogs exposed, panels custom-drawn). Confirm with Accessibility Insights.
- The Export As dialog window title is assumed to read "Export As"; the Image Size dialog "Image Size".
- Exact button labels in the Contextual Task Bar change between releases; lessons avoid it.
