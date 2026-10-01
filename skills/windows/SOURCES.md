# Sources and assumptions — Windows pack

Checked on 2026-10-01 against Microsoft documentation. Wording in this pack is original.

## Consulted

- Keyboard shortcuts in Windows: https://support.microsoft.com/en-us/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec
- Launch Windows Settings (ms-settings URI list): https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings
- Voice access setup (Settings > Accessibility > Speech): https://support.microsoft.com/en-us/accessibility/windows/voice-access/get-started-with-voice-access
- Make text and apps bigger (Scale & layout): https://support.microsoft.com/en-us/accessibility/windows/make-text-and-apps-bigger
- Snap your windows: https://support.microsoft.com/en-us/windows/snap-your-windows-885a9b1e-a983-a3b1-16cd-c531795e6241
- Uninstall or remove apps and programs: https://support.microsoft.com/en-us/windows/uninstall-or-remove-apps-and-programs-in-windows-4b55f974-2cc6-2d2b-d092-5905080eaf98

## Version assumptions

- Written for Windows 11 24H2 (build 26100). Page and category names are unchanged in 25H2.
- Settings path for scaling: System > Display > Scale & layout > Scale.
- Settings path for uninstalling: Apps > Installed apps > More (three dots button, UIA name assumed "More options") > Uninstall.
- Voice access shortcut Windows Control S exists only on recent builds; lessons use the Settings toggle and mention the shortcut as a hint.

## Not verified on a real machine

- UIA quality "good" and the exact control types (ListItem, Button, ComboBox) used in targets and checks. Names are used first; roles may need adjusting after a walkthrough with Accessibility Insights.
- regions.json fractions are estimates of the default layout, not measurements.
- The File Explorer window title being the folder name (used by window-title checks).
- No lesson has been walked through end to end yet (verifiedBy is "docs").
