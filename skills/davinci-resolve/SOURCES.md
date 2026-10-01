# Sources and assumptions

## Consulted (2026-10-01)

- Blackmagic Design DaVinci Resolve product and training pages: https://www.blackmagicdesign.com/products/davinciresolve and https://www.blackmagicdesign.com/products/davinciresolve/training
- DaVinci Resolve reference manual (Help, Documentation, Reference Manual inside the app) for page names, Render Settings, Render Queue and Color Wheels.
- Shortcut cross-checks: https://www.editorskeys.com/blogs/news/davinci-resolve-keyboard-shortcuts-pdf-cheat-sheet, https://www.davincishortcuts.com/, https://academyclass.com/blog/davinci-resolve-keyboard-shortcuts-cheat-sheet/
- Deliver workflow (YouTube preset, Add to Render Queue, Render All): https://primalvideo.com/video-creation/editing/davinci-resolve-20-complete-tutorial-for-beginners-2025
- Scripting availability by edition: https://forum.blackmagicdesign.com/viewtopic.php?f=12&t=230652 and https://www.cined.com/davinci-resolve-21-1-released-ai-assistant-integration-via-mcp-individual-hdr-trims-and-python-scripting-moves-to-studio/

## Version assumptions

- Written for Resolve 20 and 21 on Windows with the default keyboard set (`appVersion: ">=20"`).
- Page names, the bottom page bar and the shortcuts listed have been stable since Resolve 17.
- In Resolve 19 and later the toolbar button reads "Effects"; older versions say "Effects Library".

## Not yet verified on a real install

- Region fractions in `regions.json` are estimates for the default layouts at 1920 by 1080.
- UIA quality "partial" is an estimate; check with Accessibility Insights for Windows.
- The import dialog title and the exact Deliver preset tile labels can vary by version; lessons use vision checks for these.
- Bridge check keys (`page`, `timelineClipCount`, `renderJobCount`) are placeholders until the Studio bridge is built.
