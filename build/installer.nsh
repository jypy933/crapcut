; Uninstall: offer to remove the downloaded tools, models and work files
; (%LOCALAPPDATA%\CrapCut). Never during an auto-update. Exported clips in
; Videos\CrapCut are always kept.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$LOCALAPPDATA\CrapCut\*.*" 0 done
      MessageBox MB_YESNO|MB_ICONQUESTION "Also delete CrapCut's downloaded tools, AI models and work files? Your exported clips in Videos\CrapCut are kept." /SD IDNO IDNO done
        RMDir /r "$LOCALAPPDATA\CrapCut"
    done:
  ${endIf}
!macroend
