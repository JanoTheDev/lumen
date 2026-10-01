# Sources and version assumptions — VS Code pack

Checked 2026-10-01 against official documentation. Wording in this pack is our own.

## Official references

- Keyboard shortcuts for Windows (PDF): https://code.visualstudio.com/shortcuts/keyboard-shortcuts-windows.pdf
- Key bindings: https://code.visualstudio.com/docs/getstarted/keybindings
- User interface: https://code.visualstudio.com/docs/getstarted/userinterface
- Accessibility: https://code.visualstudio.com/docs/configure/accessibility/accessibility
- Source control: https://code.visualstudio.com/docs/sourcecontrol/overview
- Terminal basics: https://code.visualstudio.com/docs/terminal/basics
- Extension Marketplace: https://code.visualstudio.com/docs/configure/extensions/extension-marketplace
- Release notes 1.140: https://code.visualstudio.com/updates/v1_140

## Version assumptions

- Lessons target 1.90 or later (`appVersion: ">=1.90"`); current release at the time of writing was 1.140.
- Windows default keybindings on a US keyboard. The terminal toggle uses the backtick key, which sits elsewhere on some layouts.
- Default window title format is "file - folder - Visual Studio Code"; window-title checks rely on it and break if `window.title` is customised.
- Secondary Side Bar shows Chat by default in recent versions; the regions assume it is open.

## Unverified

- Exact UI Automation roles and names for Activity Bar items (assumed TabItem or Button named after the view, sometimes with the shortcut appended), the Source Control message box (assumed Edit) and the Extensions search box.
- Name of the Commit button may include the branch or an arrow menu; checks also accept the keypress and vision.
- Region fractions are estimates of the default layout, not pixel measurements.
