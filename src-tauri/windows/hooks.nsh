; Hooks the Windows setup installer runs around Tauri's own steps.
;
; The app was called Agent Workbench before it was Chord, and the setup
; installer keeps its install under the product's name: an Agent Workbench
; install is one this installer does not know as its own, and Chord would go
; in beside it, two entries in the list of apps and two shortcuts. Before
; installing, an Agent Workbench install of this user's, and then one of the
; machine's, is taken out by its own uninstaller, run silently and in place.
; Silently it keeps the app's data, which lives under the bundle identifier
; Chord keeps, and it takes the old shortcuts and pins with it. A machine
; install that this user may not remove is left as it was.

!macro CHORD_REMOVE_EARLIER ROOT
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ClearErrors
  ReadRegStr $R9 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Agent Workbench" "UninstallString"
  ReadRegStr $R8 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Agent Workbench" "InstallLocation"
  ${If} $R9 != ""
  ${AndIf} $R8 != ""
    ; Both are written in quotes; the folder is wanted without them.
    StrCpy $R7 $R8 1
    ${If} $R7 == '"'
      StrCpy $R8 $R8 -1 1
    ${EndIf}
    ClearErrors
    ExecWait '$R9 /S _?=$R8' $R6
    ${IfNot} ${Errors}
    ${AndIf} $R6 = 0
      ; Run in place, the uninstaller cannot remove itself or its folder.
      Delete "$R8\uninstall.exe"
      RMDir "$R8"
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CHORD_REMOVE_EARLIER HKCU
  !insertmacro CHORD_REMOVE_EARLIER HKLM
!macroend
