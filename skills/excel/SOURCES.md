# Sources and assumptions — Excel pack

Checked on 2026-10-01 against Microsoft documentation. Wording in this pack is original.

## Consulted

- Keyboard shortcuts in Excel: https://support.microsoft.com/en-us/office/keyboard-shortcuts-in-excel-1798d9d5-842a-42b8-9c99-9b7213f0040f
- Ribbon tab names (Home, Insert, Page Layout, Formulas, Data, Review, View) from the same page.

## Version assumptions

- Excel for Microsoft 365 desktop on Windows, Current Channel 2409 or later, classic (expanded) ribbon.
- Labels used: Home > Editing > AutoSum; Home > Styles > Format as Table; Insert > Charts > Recommended Charts; Data > Sort & Filter > Filter; contextual tabs Table Design and Chart Design.
- Create Table dialog has a "My table has headers" check box.
- Excel 2019 and 2021 use the same labels; older versions name the table tab Design.

## Not verified on a real machine

- UIA quality "good", and that a cell's UIA name is its address with the content readable through ValuePattern (used by uia-event value checks). Each such check has a vision fallback.
- regions.json fractions are estimates, not measurements.
- No lesson has been walked through end to end yet (verifiedBy is "docs").
