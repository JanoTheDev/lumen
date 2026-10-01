# Installing Lumen

Lumen runs on Windows only. This page covers downloading, the Windows warning you will see,
where Lumen keeps its files, updates and uninstalling. Building from source is in the
[README](../README.md#run-from-source).

## What you need

- Windows 10 22H2 or later, or Windows 11, 64-bit (x64).
- A microphone (built-in, headset or USB).
- An internet connection, and an API key from Anthropic or OpenAI. You only need one:
  - Anthropic: [console.anthropic.com](https://console.anthropic.com/settings/keys)
  - OpenAI: [platform.openai.com](https://platform.openai.com/api-keys)

  Both charge for use by the request; Settings → Models shows an estimate of what you have used
  per day. Lumen itself is free.

- No Administrator rights, no Python, nothing else to install.

## 1. Download

Open the [Releases page](https://github.com/JanoTheDev/lumen/releases) and, under the newest
release, download one of these:

| File                           | Use it when                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `Lumen-Setup-<version>.exe`    | You want Lumen installed, in the Start menu, updating itself. **Pick this one if unsure.** |
| `Lumen-<version>-portable.exe` | You want to run Lumen without installing it, for example from a USB stick.                 |

Optional: check that the download is intact. Each release has a `SHA256SUMS.txt`. In PowerShell,
in your Downloads folder:

```powershell
Get-FileHash .\Lumen-Setup-<version>.exe
```

The long hash it prints must match the line for that file in `SHA256SUMS.txt`.

## 2. Get past the Windows warning (SmartScreen)

Lumen is not code-signed (signing certificates cost money every year), so the first time you run
it Windows shows a blue box: **"Windows protected your PC"**.

1. Click **More info** (the small link under the text).
2. Check that the app name is `Lumen-Setup-<version>.exe` (or the portable file name).
3. Click **Run anyway**.

You only need to do this once per downloaded file. If your browser warns that the file "is not
commonly downloaded", choose **Keep** (in Edge: the `...` menu next to the download, then
**Keep**, then **Show more** → **Keep anyway**).

If your antivirus blocks the file, that is usually because it is new and unsigned. You can check
the hash above, and report a false positive to your antivirus vendor.

## 3. Install

The installer has no pages to click through. It installs for your Windows user only, in

```
%LOCALAPPDATA%\Programs\lumen
```

adds Lumen to the Start menu, and opens it. Lumen lives in the notification area (the tray, next
to the clock); right-click its icon for Settings and help.

The first time, a short setup asks for your API key and walks you through a practice round. Your key is encrypted with Windows (DPAPI) and saved in
`%USERPROFILE%\.ai-overlay\keys.dat`; it is never stored in the settings file or the logs.

Then hold **Ctrl+Shift+Space**, speak, and release.

Speech recognition and wake-word models (about 100 MB and 18 MB) download the first time you turn
those features on. Each download is checked against a fixed hash before it is used.

## Start at login

Settings → General → **Start Lumen when I sign in**. Lumen then starts quietly in the tray when
you sign in to Windows. It is off by default and not available in the portable version.

## Updates

The installed version checks GitHub for a new release once a day. When there is one, it
downloads in the background and installs the next time you quit Lumen. Lumen never restarts by
itself; to update straight away, use Settings → About → **Restart to update**.

- Turn this off in Settings → About → **Check for updates automatically**. You can still press
  **Check for updates** there.
- Updates come only from this project's GitHub Releases, over HTTPS, and the installer is checked
  against the SHA-512 hash published with the release before it runs.
- No usage data is sent; the check is a plain download of the release's `latest.yml`.
- The portable version does not update itself. It shows a link to the new version in
  Settings → About; download it and replace the old file.

## Portable version

`Lumen-<version>-portable.exe` runs without installing. It uses the same settings and key folder
as the installed version (`%USERPROFILE%\.ai-overlay`), never adds itself to start at login, and
never writes to the registry. Settings → About says "(portable)" after the version number.
Delete the exe to remove it; delete the folders listed below to remove your settings too.

## Where Lumen keeps things

| What                                                    | Where                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| The app                                                 | `%LOCALAPPDATA%\Programs\lumen`                                  |
| Settings, saved key, memory, lessons, downloaded models | `%USERPROFILE%\.ai-overlay`                                      |
| Logs and local crash reports                            | `%APPDATA%\Lumen\logs` (Settings → About → **Open logs folder**) |
| Downloaded updates waiting to install                   | `%LOCALAPPDATA%\lumen-updater`                                   |

Settings → About → **Export diagnostics** makes a zip of the logs, crash reports and settings
with keys removed, for attaching to a bug report.

## Uninstall

Windows Settings → **Apps** → **Installed apps** (Windows 10: **Apps & features**) → Lumen →
**Uninstall**.

- Always removed: the app and the start-at-login entry.
- The uninstaller then asks **"Also remove your Lumen settings, saved API keys and downloaded voice
  models?"**
  - **No** (the default) keeps `%USERPROFILE%\.ai-overlay` and `%APPDATA%\Lumen`, so a later
    reinstall picks up where you left off.
  - **Yes** also deletes `%USERPROFILE%\.ai-overlay`, `%APPDATA%\Lumen`, `%LOCALAPPDATA%\Lumen`
    and `%LOCALAPPDATA%\lumen-updater`.
- Updating never removes any of your data.

Your API key stays valid at Anthropic or OpenAI after uninstalling; revoke it on their website if
you no longer need it.

## Privacy in short

Requests go straight from your PC to the AI provider whose key you entered. Speech recognition,
wake word, text recognition and the screen reader output run on your PC. Screenshots are sent
with a request and not saved. There is no telemetry; crash reports stay on your PC. More in the
[README](../README.md#privacy).
