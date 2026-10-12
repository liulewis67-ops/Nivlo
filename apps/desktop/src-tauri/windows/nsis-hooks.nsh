; 卸载时的自定义步骤（实施计划 7.6）。
;
; Tauri 自带的卸载界面有一个「删除应用数据」复选框，但它只清理 WebView 缓存目录
; （%APPDATA%\<bundle id>）。Nivlo 自己的数据（数据库、附件、日志、导出）在 %APPDATA%\Nivlo，
; 所以用户勾选这个复选框时，这里一并删除；不勾选（默认）则保留。升级（/UPDATE）永远不删。
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\Nivlo"
  ${EndIf}
!macroend
