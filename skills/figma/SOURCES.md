# Sources and version assumptions

Checked on 2026-10-01 against Figma Design (UI3), web and desktop app on Windows. Content written in our own words.

## Official

- Navigate Figma Design files (toolbar, sidebars): https://help.figma.com/hc/en-us/articles/30925881896727-FD4B-Navigate-Figma-Design-files
- Right sidebar (Design and Prototype tabs): https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar
- Navigation bar and left sidebar: https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar
- Add prototype connections: https://help.figma.com/hc/en-us/articles/31011968186007-FD4B-Add-prototype-connections
- Use Figma with a keyboard: https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard

## Version assumptions

- Figma is a rolling web release; `appVersion` is "UI3" (the layout with the floating bottom toolbar, live since 2024).
- Desktop app process `Figma.exe`; browser URLs `figma.com/design/*` and legacy `figma.com/file/*`.
- Windows default shortcuts. The in-app shortcuts panel (Control Shift question mark) is the authority when something differs.

## Unverified

- The full shortcut list was cross-checked with the in-app panel's categories as described in help and with several shortcut references, not with a live session. Present (Control Alt Enter), Section (Shift S) and Dev Mode (Shift D) are the least certain.
- `regions.json` values are estimates for the desktop app on 1920x1080.
- UIA quality "partial" is an estimate (browser accessibility tree for sidebars and toolbar). Confirm with Accessibility Insights.
- Export section labels in the right sidebar ("Export", the add button, "Export <layer name>") follow current help screenshots.
