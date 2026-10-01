# Windows 11

## What this app is for

Windows is the operating system: it starts apps, manages windows and files, and holds every system setting. Most beginner tasks happen in three places: the Start menu, the Settings app and File Explorer.

## Layout

- **Taskbar** (`taskbar`): the bar along the bottom of the screen. Start button and pinned apps sit in the middle by default; the clock, volume and network icons are at the bottom right.
- **Start menu**: opens above the taskbar when you press the Windows key. A search box sits at the top.
- **Settings** has two columns:
  - **Navigation pane** (`settings-nav`): the category list on the left (System, Bluetooth and devices, Network and internet, Personalization, Apps, Accounts, Time and language, Gaming, Accessibility, Privacy and security, Windows Update).
  - **Content area** (`settings-content`): the page for the selected category on the right. Its title and breadcrumb are at the top, for example "System > Display".
  - **Find a setting** (`settings-search`): the search box above the navigation pane.
- **File Explorer** has:
  - **Address bar** (`explorer-address-bar`) and search box along the top, with tabs above them.
  - **Command bar** (`explorer-command-bar`): New, Cut, Copy, Paste, Rename, Share, Delete, Sort, View.
  - **Navigation pane** (`explorer-nav-pane`): Home, Gallery, quick access folders, This PC, on the left.
  - **File list** (`explorer-file-list`): the files and folders of the current folder, in the middle.

Regions are fractions of the default, maximized window. Custom layouts, a moved taskbar or a resized Settings window break them; the engine then falls back to element names, OCR or vision.

## Modes / pages

- **Settings page**: the window title is "Settings"; the content header names the page. Deep links such as `ms-settings:display` jump straight to a page.
- **File Explorer**: the window title is the current folder name, for example "Documents".
- **Snap Assist**: after snapping one window, thumbnails of the other open windows fill the empty half until you pick one or press Escape.
- **Security prompt (UAC)**: a dimmed screen asking "Do you want to allow this app to make changes". It runs on the secure desktop: nothing can click it for the user.

## Core concepts

- **App vs window**: one app can have several windows; the taskbar groups them under one icon.
- **Settings category / page**: categories in the left pane open pages; each page has rows you click to go deeper.
- **Toggle**: an On/Off switch on a settings row. Changes apply right away; there is no Save button.
- **Folder path**: where a file lives, shown in the address bar, for example This PC > Documents > Practice.
- **Snap**: placing a window on exactly half or a quarter of the screen.
- **Installed apps**: the list in Settings > Apps where apps are removed.
- **Recycle Bin**: deleted files go here first and can be restored.

## Gotchas for beginners

- Settings changes apply instantly. To undo, set the old value again; Control Z does not work in Settings.
- Display scale changes may need a sign out before every app looks right.
- In File Explorer, Control Z undoes the last rename, move or delete.
- Typing while a file is selected in Explorer jumps to a file with that name; press F2 to rename instead.
- Uninstalling cannot be undone with Control Z; the app must be installed again.

## Accessibility notes

- Settings, File Explorer, the taskbar and Start expose names and roles to UI Automation, so targets use element names.
- Everything is keyboard reachable: Windows I opens Settings, Windows E opens File Explorer, Tab and the arrow keys move between items, Space or Enter activates.
- Windows U opens Accessibility settings directly. Narrator toggles with Windows Control Enter; Magnifier with Windows plus or Windows minus; voice access with Windows Control S on recent builds.
- Prefer deep links for "do it for me": they open the right page without any pointing.
