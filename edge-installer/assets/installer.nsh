; installer.nsh — Custom NSIS hooks for EdgeNest
; Called by electron-builder during NSIS generation.

; Ask user whether to keep settings on uninstall
!macro customUnInstall
  MessageBox MB_YESNO "Keep your EdgeNest settings and logs in %APPDATA%\EdgeNest?" IDYES keepData
    RMDir /r "$APPDATA\EdgeNest"
  keepData:
!macroend

; Register "Start with Windows" registry entry when the user ticks the checkbox
; (The app itself also handles this via Electron's app.setLoginItemSettings,
;  but this macro provides a belt-and-suspenders approach during install.)
!macro customInstall
  ; Nothing extra needed — app handles autostart via setLoginItemSettings
!macroend
