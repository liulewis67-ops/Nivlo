; 安装 / 卸载时的自定义步骤（实施计划 7.6、10.6）。
;
; * 安装：为当前用户注册 starat:// 协议。通知被点击时 Windows 以 "starat://item/<ID>" 启动本程序，
;   单实例机制再把它转给正在运行的实例（没在运行就是冷启动）。只写 HKCU，不需要管理员权限。
; * 已安装过 StarAt 时：不询问「是否先卸载旧版」，直接原地覆盖升级（见下方 StarAtUpgradeInPlace）。
; * 卸载：删除协议注册；**永远不删除用户数据**。
;
; 注意：本文件在模板里被 !include 得很早（在 VERSION 等 !define 与模板的 Var 声明之前），
; 所以这里的函数不能引用 ${VERSION}、$UpdateMode、$PassiveMode 等模板符号。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\starat" "" "URL:StarAt"
  WriteRegStr HKCU "Software\Classes\starat" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\starat\shell\open\command" "" '"$INSTDIR\starat-desktop.exe" "%1"'
  ; 已发送的通知仍可能携带旧协议。
  WriteRegStr HKCU "Software\Classes\stardeskbox" "" "URL:StarAt"
  WriteRegStr HKCU "Software\Classes\stardeskbox" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\stardeskbox\shell\open\command" "" '"$INSTDIR\starat-desktop.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\nivlo" "" "URL:StarAt"
  WriteRegStr HKCU "Software\Classes\nivlo" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\nivlo\shell\open\command" "" '"$INSTDIR\starat-desktop.exe" "%1"'
  ; 仅迁移已经启用的旧启动项，保留用户的启用 / 停用选择。
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarDeskBox"
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Nivlo"
  StrCmp $0 "" 0 migrate_autostart
  StrCmp $1 "" autostart_done
  migrate_autostart:
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarAt" '"$INSTDIR\starat-desktop.exe" --autostarted'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarDeskBox"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Nivlo"
  autostart_done:
!macroend

; 覆盖安装：手动运行安装包、而本机已经装过 StarAt（任何版本）时，Tauri 模板会弹出「已安装」页，
; 默认「安装前先卸载」并运行旧版卸载程序。改为：以 /P /UPDATE /R 重新启动自己——
; 与应用内更新同一条路径：沿用原安装目录、不卸载、不动快捷方式与开机自启，只显示进度条，装完自动启动 StarAt。
; 静默安装（/S）不经过界面初始化，不受影响；已经带 /UPDATE 的（应用内更新、或本函数重启出的进程）直接放行。
!define MUI_CUSTOMFUNCTION_GUIINIT StarAtUpgradeInPlace
Function StarAtUpgradeInPlace
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  IfErrors 0 done
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarAt" "UninstallString"
  StrCmp $0 "" 0 upgrade
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDeskBox" "UninstallString"
  StrCmp $0 "" 0 upgrade
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nivlo" "UninstallString"
  StrCmp $0 "" done
  upgrade:
  Exec '"$EXEPATH" /P /UPDATE /R'
  Quit
  done:
FunctionEnd

; 卸载时的自定义步骤。
;
; **卸载程序永远不删除 StarAt 的数据目录（%APPDATA%\StarAt：数据库、附件、日志、备份）。**
; 以前勾选「删除应用程序数据」会连它一起删；手动升级时旧版卸载程序会出现在升级途中，
; 一次误点就清空了用户数据（2026-11-06 实测发生过）。想清空数据请用应用内「设置 → 数据 → 删除所有数据」（会先自动备份）。
; 复选框本身仍会删除 Tauri 的 WebView 目录（%LOCALAPPDATA%\app.stardeskbox.desktop：缓存与界面偏好），那是模板行为。
!macro NSIS_HOOK_POSTUNINSTALL
  ; 升级（/UPDATE）会先卸载再安装，协议注册由随后的 POSTINSTALL 重新写入。
  DeleteRegKey HKCU "Software\Classes\starat"
  DeleteRegKey HKCU "Software\Classes\stardeskbox"
  DeleteRegKey HKCU "Software\Classes\nivlo"
!macroend
