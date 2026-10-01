# Sources and assumptions

## Consulted (2026-10-01)

- Adobe help, default keyboard shortcuts: https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html
- Adobe help, Properties panel: https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/about-properties-panel.html
- Adobe release notes: https://helpx.adobe.com/premiere-pro/kb/fixed-issues.html
- Rebrand to Premiere in version 26: https://petapixel.com/2026/01/20/rebranded-adobe-premiere-26-arrives-with-one-click-object-tracking/ and https://www.dpreview.com/news/7068552137/adobe-premiere-26-object-selection-launch-rebrand-r3d-ne/
- Shortcut cross-check: https://www.editorskeys.com/blogs/news/premiere-pro-keyboard-shortcuts-pdf-cheat-sheet
- Essential Graphics replaced by Properties and Graphics Templates in 25.x: https://academyclass.com/blog/how-to-add-text-in-premiere-pro/

## Version assumptions

- Written for Premiere Pro 25 and Premiere 26 on Windows with the default keyboard layout (`appVersion: ">=25.0"`).
- Version 25 and later use the Import, Edit and Export mode tabs in the header bar, and text styling in the Properties panel.
- The executable is matched as both "Adobe Premiere Pro.exe" and "Adobe Premiere.exe" because the rebrand was cosmetic at launch.

## Not yet verified on a real install

- Region fractions in `regions.json` are estimates for the default Editing workspace at 1920 by 1080.
- UIA quality "partial" is an estimate; check with Accessibility Insights for Windows, especially the Audio Gain dialog name used by a uia-event check.
- Export mode field labels (File Name, Location, Preset, Format) follow the 25.x layout and may move in later releases.
