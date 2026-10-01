; Lumen NSIS hooks (included by electron-builder).
; Uninstall: always drop the start-at-login entry; ask before deleting settings, keys and models.
; Updates run the old uninstaller with --updated: nothing is removed then.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Lumen"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Lumen"
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
