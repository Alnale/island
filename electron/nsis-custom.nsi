; 卸载入口:开始菜单创建「卸载 灵动岛挂件」快捷方式
; (electron-builder 26 辅助安装模式默认不生成独立的卸载快捷方式,
;  这里经 customInstall / customUnInstall 钩子补齐:
;  安装/升级时创建,卸载时连同安装目录数据一并清除)
; 注意:宏体内的 ${UNINSTALL_FILENAME} 在调用时才展开,此时 common.nsh 已加载
!macro customInstall
  CreateShortCut "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

; 卸载时**选择是否保留个人数据**(用户要求,2026-08-06):
; - electron-builder 26 的 deleteAppDataOnUninstall 确认卸载即删、无选择,
;   已在 electron-builder.yml 关闭,改由本脚本的卸载页面 + 条件删除接管:
;   卸载第一页 = 复选框「保留我的数据(推荐)」**默认勾选**(防误删,
;   数据删除不可恢复);未勾选 → customUnInstall 连同 %APPDATA%\dynamic-island
;   (package.json 的 name,非中文 productName)一并删除。
; - 实现:customUnWelcomePage 钩子(assistedInstaller.nsh 检测到已定义就
;   用它替代默认卸载欢迎页)——在标准欢迎页**之前**插入本页(卸载先问
;   数据去留,默认保留可直接下一步);MUI_UNPAGE_WELCOME 由本宏补插。
; - 页面与函数都在宏体内:本文件被 !include 在 installer.nsi **最前面**
;   (MUI2/nsDialogs/LogicLib 尚未加载),宏体到 assistedInstaller.nsh 的
;   插入点才展开,届时全部可用;无 BOM 的 UTF-8 中文与现有宏一致。
; - 静默卸载(/S)跳过页面,$IslandKeepData 为空 → 按默认保留处理。
;   变量在宏体内声明(展开时位于顶层,先于 customUnInstall 的使用点)
!macro customUnWelcomePage
  Var IslandKeepData
  UninstPage custom un.KeepDataPage
  !insertmacro MUI_UNPAGE_WELCOME
  Function un.KeepDataPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 12u 100% 20u "卸载将删除程序文件。是否同时删除个人数据?"
    Pop $0
    ${NSD_CreateLabel} 0 38u 100% 44u "个人数据包括:设置、长期记忆、技能、上传的音乐、背景与字体。删除后不可恢复。"
    Pop $0
    ${NSD_CreateCheckBox} 0 92u 100% 20u "保留我的数据(推荐)"
    Pop $IslandKeepData
    ${NSD_SetState} $IslandKeepData ${BST_CHECKED}
    nsDialogs::Show
    ${NSD_GetState} $IslandKeepData $0
    StrCpy $IslandKeepData $0
  FunctionEnd
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk"
  ; 卸载页面的选择:未勾选「保留我的数据」→ 删除用户数据目录
  ; ($APPDATA\dynamic-island);勾选(默认)/静默卸载 = 保留
  ${IfNot} ${Silent}
    ${If} $IslandKeepData != ${BST_CHECKED}
      RMDir /r "$APPDATA\dynamic-island"
    ${EndIf}
  ${EndIf}
!macroend
