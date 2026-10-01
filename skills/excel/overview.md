# Microsoft Excel

## What this app is for

Excel stores data in a grid of cells and calculates with it. People use it for lists, budgets, schedules and charts.

## Layout

- **Title bar and Quick Access Toolbar** (`title-bar`): file name at the top, with Save and Undo nearby and a search box in the middle.
- **Ribbon tabs** (`ribbon-tabs`): File, Home, Insert, Page Layout, Formulas, Data, Review, View, Help. Extra tabs such as Table Design or Chart Design appear only while a table or chart is selected.
- **Ribbon** (`ribbon`): the buttons of the selected tab, arranged in labelled groups (for example Home > Editing > AutoSum).
- **Name Box** (`name-box`): left end of the bar under the ribbon; shows the address of the selected cell, such as B4.
- **Formula bar** (`formula-bar`): right of the Name Box; shows what is really in the cell, for example =SUM(B2:B7).
- **Grid** (`grid`): the cells. Columns are letters across the top, rows are numbers down the left.
- **Sheet tabs** (`sheet-tabs`): bottom left; each tab is a worksheet. The plus button adds one.
- **Status bar** (`status-bar`): bottom edge; shows Sum, Average and Count of the selected cells, plus zoom.

Regions assume a maximized window with the ribbon expanded. Custom layouts, a collapsed ribbon or a different zoom break them; the engine then falls back to element names, OCR or vision.

## Modes / pages

- **Ready**: the status bar says Ready; arrow keys move between cells.
- **Enter / Edit**: typing into a cell (status bar says Enter, or Edit after F2). Arrow keys may move the text cursor instead of the cell. Press Enter to confirm or Escape to cancel.
- **Backstage view**: the full-window File menu (Save As, Open, Print). The grid is hidden. Escape returns.
- **Contextual tabs**: Table Design and Chart Design show only when a table or chart is selected.

## Core concepts

- **Cell / address**: one box in the grid, named by column and row, like C3.
- **Range**: a block of cells, written first:last, like B2:B7.
- **Formula**: anything starting with an equals sign; Excel shows the result in the cell and the formula in the formula bar.
- **Function**: a named calculation such as SUM or AVERAGE used inside a formula.
- **Fill handle**: the small square at the bottom right of the selection; drag it to copy or continue a series.
- **Table**: a range turned into a structured object with headers, filter buttons and banded rows.
- **Sort and filter**: reorder rows, or hide rows that don't match.
- **Chart**: a picture of the data that updates when the data changes.

## Gotchas for beginners

- A cell is only saved when you leave it with Enter, Tab or a click. While typing, most ribbon buttons are greyed out.
- Typing over a selected cell replaces its contents; use F2 to edit instead.
- Sorting only part of the data scrambles rows. Click one cell inside the data and let Excel find the whole block, or use a table.
- Control Z undoes most changes, including sorting and formatting.
- Text that looks like a number (left aligned) won't add up in SUM.

## Accessibility notes

- The ribbon, Name Box, formula bar, sheet tabs and cells are exposed to UI Automation; cells report their address and value.
- Everything is keyboard reachable: press Alt to show key tips on the ribbon (Alt, H for Home), F6 cycles between ribbon, grid and status bar.
- Charts and the fill handle are mouse-oriented; prefer Alt F1 for a chart and Control D or Control E for filling.
- Narrator and other screen readers announce the active cell address and contents.
