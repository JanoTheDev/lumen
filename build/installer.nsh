; Lumen NSIS hooks (included by electron-builder).
; Uninstall: always drop the start-at-login entry and the automations' wake-up tasks; ask before
; deleting settings, keys and models.
; Updates run the old uninstaller with --updated: nothing is removed then.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Lumen"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Lumen"
    ; Automations' wake-up tasks (Task Scheduler folder \Lumen\, the user's own tasks).
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Get-ScheduledTask -TaskPath '\Lumen\' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$$false -ErrorAction SilentlyContinue; try { $$s = New-Object -ComObject Schedule.Service; $$s.Connect(); $$s.GetFolder('\').DeleteFolder('Lumen', 0) } catch {}"`
    Pop $0
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also remove your Lumen settings, saved API keys and downloaded voice models?$\r$\n$\r$\nChoose No to keep them for a later reinstall." \
        /SD IDNO IDNO lumen_keep_data
      RMDir /r "$PROFILE\.ai-overlay"
      RMDir /r "$APPDATA\Lumen"
      RMDir /r "$LOCALAPPDATA\Lumen"
      RMDir /r "$LOCALAPPDATA\lumen-updater"
      lumen_keep_data:
    ${endIf}
  ${endIf}
!macroend
