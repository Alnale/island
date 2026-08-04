; 卸载入口:开始菜单创建「卸载 灵动岛挂件」快捷方式
; (electron-builder 26 辅助安装模式默认不生成独立的卸载快捷方式,
;  这里经 customInstall / customUnInstall 钩子补齐:
;  安装/升级时创建,卸载时连同安装目录数据一并清除)
; 注意:宏体内的 ${UNINSTALL_FILENAME} 在调用时才展开,此时 common.nsh 已加载
!macro customInstall
  CreateShortCut "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk"
!macroend
