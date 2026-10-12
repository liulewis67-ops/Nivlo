; 安装 / 卸载时的自定义步骤（实施计划 7.6、10.6）。
;
; * 安装：为当前用户注册 nivlo:// 协议。通知被点击时 Windows 以 "nivlo://item/<ID>" 启动本程序，
;   单实例机制再把它转给正在运行的实例（没在运行就是冷启动）。只写 HKCU，不需要管理员权限。
; * 卸载：删除协议注册。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\nivlo" "" "URL:Nivlo"
  WriteRegStr HKCU "Software\Classes\nivlo" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\nivlo\shell\open\command" "" '"$INSTDIR\nivlo-desktop.exe" "%1"'
!macroend

; 卸载时的自定义步骤（实施计划 7.6）。
;
; Tauri 自带的卸载界面有一个「删除应用数据」复选框，但它只清理 WebView 缓存目录
; （%APPDATA%\<bundle id>）。Nivlo 自己的数据（数据库、附件、日志、导出）在 %APPDATA%\Nivlo，
; 所以用户勾选这个复选框时，这里一并删除；不勾选（默认）则保留。升级（/UPDATE）永远不删。
!macro NSIS_HOOK_POSTUNINSTALL
  ; 升级（/UPDATE）会先卸载再安装，协议注册由随后的 POSTINSTALL 重新写入。
  DeleteRegKey HKCU "Software\Classes\nivlo"
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\Nivlo"
  ${EndIf}
!macroend
