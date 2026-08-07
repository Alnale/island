; ===========================================================================
; 安装向导视觉定制(2026-08-07 用户要求:高定制化美观,背景 = 一整张
; 自定义大图片,而非框架式布局)
;
; 背景图:electron/installer-bg.bmp(由 scripts/gen-installer-bg.mjs 从
; 项目根 bg.png 缩放生成 800×533 24bit BMP)。NSIS 侧在 onGUIInit 里
; File 解压到 $PLUGINSDIR → LoadImage 按客户区尺寸拉伸 → 创建 STATIC
; 位图控件铺满主对话框并置底(HWND_BOTTOM)——所有向导页面共享主对话框,
; 背景一次创建全程可见;页面标签/头部/品牌条背景全部透明(MUI_BGCOLOR
; = transparent),文字颜色 MUI_TEXTCOLOR 按浅色背景图取深色。
; 欢迎/完成页左下 164×314 的默认侧栏位图与整窗背景冲突 → 定时器检测
; 页面控件创建后隐藏(每页一次)。
; 卸载向导同款背景(un.IslandGUIInit);卸载数据保留页(nsDialogs 子
; 对话框)也铺一张背景图 + 标签透明化。
;
; 注意:本文件被 !include 在 installer.nsi **最前面**(MUI2 尚未加载),
; 顶层 !define 在页面宏/语言文件展开前生效(MUI2 用 !insertmacro
; MUI_DEFAULT 兜底,已定义则保留);函数定义放在 customWelcomePage /
; customUnWelcomePage 宏体内(assistedInstaller.nsh 的插入点才展开,
; 此时 MUI2 已加载、变量已声明,且早于 MUI_LANGUAGE 触发的
; MUI_INSERT——.onGUIInit 展开时函数已就绪)。
; 文件必须带 UTF-8 BOM(NSIS include 按 BOM 检测编码)。

; ---- 整窗背景 + 透明化(顶层宏定义)----
!define MUI_BGCOLOR "transparent"
!define MUI_TEXTCOLOR "22304A"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_BRANDINGTEXT "灵动岛挂件"
!define MUI_CUSTOMFUNCTION_GUIINIT "IslandGUIInit"
!define MUI_CUSTOMFUNCTION_UNGUIINIT "un.IslandGUIInit"

; ---- 页面文案 ----
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 灵动岛挂件$\r$\n你的桌面,灵动随行"
!define MUI_WELCOMEPAGE_TEXT "灵动岛桌面挂件 —— 复刻 iOS 灵动岛的桌面悬浮窗。$\r$\n$\r$\n本向导将把「灵动岛挂件」安装到你的电脑。$\r$\n$\r$\n点击「下一步」开始安装,点击「取消」退出。"
!define MUI_FINISHPAGE_TITLE "灵动岛挂件 安装完成"
!define MUI_FINISHPAGE_TEXT "感谢选择「灵动岛挂件」!$\r$\n$\r$\n托盘右键菜单可随时切换「音乐模式」与「Agent 模式」;$\r$\n设置与卸载入口都在托盘菜单里。"
!define MUI_ABORTWARNING
!define MUI_UNWELCOMEPAGE_TITLE "卸载 灵动岛挂件"
!define MUI_UNWELCOMEPAGE_TEXT "本向导将卸载「灵动岛挂件」。$\r$\n$\r$\n下一步会询问是否保留个人数据(设置、长期记忆、技能、上传的音乐与背景)。"

; ===========================================================================
; 整窗背景初始化函数(安装/卸载)
;
; **必须定义在文件顶层**:MUI_LANGUAGE 触发 MUI_INSERT 生成的
; .onGUIInit 在 assistedInstaller.nsh(页面宏)之前展开,函数若放在
; customWelcomePage 宏体内会晚于 .onGUIInit 定义,编译报
; "resolving install function" 错误。顶层展开时 MUI2 未加载,所以
; 本函数**不得引用任何 MUI2 变量**($mui.*)——只用到内置变量
; $0-$9/$HWNDPARENT 与插件命令,安全。定时器回调
; (IslandHideTimerProc)需要 $mui.* 变量,保留在 customWelcomePage
; 宏体内定义——CreateFunctionAddress 是运行时指令,只按字符串取
; 函数地址,编译期不检查函数是否已定义,运行时机函数必然就绪。
; 卸载侧同款(un.IslandGUIInit,卸载向导无侧栏位图,不需要定时器)。

; 安装侧整窗背景(MUI_CUSTOMFUNCTION_GUIINIT → .onGUIInit → Call)
Function IslandGUIInit
  ; ① 解压背景 BMP 到 $PLUGINSDIR(File 指令在函数内合法,
  ;    MUI2 官方 Welcome GUIInit 同款模式)
  InitPluginsDir
  File "/oname=$PLUGINSDIR\installer-bg.bmp" "${BUILD_RESOURCES_DIR}\installer-bg.bmp"
  ; ② 主对话框客户区尺寸(分配 16 字节 RECT)
  System::Call '*(i 0, i 0, i 0, i 0) p .r0'
  System::Call 'user32::GetClientRect(i $HWNDPARENT, p r0) i'
  System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
  System::Free $0
  ; ③ 按客户区尺寸拉伸加载位图(LR_LOADFROMFILE=0x10, IMAGE_BITMAP=0)
  System::Call 'user32::LoadImage(i 0, t "$PLUGINSDIR\installer-bg.bmp", i 0, i $r3, i $r4, i 0x10) i .r5'
  ; ④ STATIC 位图控件铺满客户区(WS_CHILD|WS_VISIBLE|SS_BITMAP)
  System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i $r3, i $r4, i $HWNDPARENT, i 0, i 0, i 0) i .r6'
  SendMessage $6 0x0172 0 $5 ; STM_SETIMAGE
  ; 置底(HWND_BOTTOM=1, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE=0x13):
  ; 页面控件后创建自然在上,置底防窗口重绘时 Z 序错乱
  System::Call 'user32::SetWindowPos(i $6, i 1, i 0, i 0, i 0, i 0, i 0x0013) i'
  ; ⑤ 主对话框背景透明(WM_CTLCOLORDLG → NULL_BRUSH;客户区由
  ;    背景控件铺满,透明化只影响页面控件缝隙)
  SetCtlColors $HWNDPARENT "" transparent
  ; ⑥ 欢迎/完成页左下侧栏位图(默认 nsis3-metro.bmp)与整窗背景
  ;    冲突:经页面 show 钩子隐藏(见 customWelcomePage /
  ;    customFinishPage 宏体内的 IslandWelcomeShow / IslandFinishShow)
FunctionEnd

; ===========================================================================
; 安装侧:欢迎页(assistedInstaller.nsh 检测到 customWelcomePage 宏就
; 插入,补上 electron-builder 辅助安装默认没有的欢迎页)+ 完成页
; (customFinishPage 宏替换默认完成页,补上 electron-builder 的「运行」
; 勾选逻辑并隐藏侧栏位图)。两页的 show 钩子函数定义在此处(展开于
; assistedInstaller.nsh 插入点,MUI2 已加载,$mui.* 变量已声明;
!macro customWelcomePage
  ; 欢迎页 show 时隐藏左下侧栏位图(与整窗背景冲突)
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "IslandWelcomeShow"
  !insertmacro MUI_PAGE_WELCOME
  Function IslandWelcomeShow
    ShowWindow $mui.WelcomePage.Image 0
  FunctionEnd
!macroend

; 完成页:复刻 assistedInstaller.nsh 默认完成页逻辑(MUI_FINISHPAGE_RUN
; + StartApp 启动函数),另挂 show 钩子隐藏侧栏位图
!macro customFinishPage
  Function StartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "IslandFinishShow"
  !insertmacro MUI_PAGE_FINISH
  Function IslandFinishShow
    ShowWindow $mui.FinishPage.Image 0
  FunctionEnd
!macroend

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

  ; 卸载向导整窗背景(MUI_CUSTOMFUNCTION_UNGUIINIT → un.onGUIInit →
  ; Call 本函数)。**必须定义在宏体内**:卸载代码若出现在正式安装器
  ; 编译(无 BUILD_UNINSTALLER)会触发 NSIS warning 6020("Uninstaller
  ; script code found but WriteUninstaller never used"),electron-builder
  ; 以 -WX 把 warning 升级为 error 编译失败(实测)
  Function un.IslandGUIInit
    InitPluginsDir
    File "/oname=$PLUGINSDIR\installer-bg.bmp" "${BUILD_RESOURCES_DIR}\installer-bg.bmp"
    System::Call '*(i 0, i 0, i 0, i 0) p .r0'
    System::Call 'user32::GetClientRect(i $HWNDPARENT, p r0) i'
    System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
    System::Free $0
    System::Call 'user32::LoadImage(i 0, t "$PLUGINSDIR\installer-bg.bmp", i 0, i $r3, i $r4, i 0x10) i .r5'
    System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i $r3, i $r4, i $HWNDPARENT, i 0, i 0, i 0) i .r6'
    SendMessage $6 0x0172 0 $5
    System::Call 'user32::SetWindowPos(i $6, i 1, i 0, i 0, i 0, i 0, i 0x0013) i'
    SetCtlColors $HWNDPARENT "" transparent
  FunctionEnd

  Function un.KeepDataPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ; 数据保留页是 nsDialogs 子对话框(白底盖住主对话框背景图):
    ; 同样铺一张背景 STATIC 置底 + 控件背景透明化
    System::Call '*(i 0, i 0, i 0, i 0) p .r1'
    System::Call 'user32::GetClientRect(i $0, p r1) i'
    System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
    System::Free $1
    System::Call 'user32::LoadImage(i 0, t "$PLUGINSDIR\installer-bg.bmp", i 0, i $r4, i $r5, i 0x10) i .r6'
    System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i $r4, i $r5, i $0, i 0, i 0, i 0) i .r7'
    SendMessage $7 0x0172 0 $6
    System::Call 'user32::SetWindowPos(i $7, i 1, i 0, i 0, i 0, i 0, i 0x0013) i'
    SetCtlColors $0 "" transparent
    ${NSD_CreateLabel} 0 12u 100% 20u "卸载将删除程序文件。是否同时删除个人数据?"
    Pop $1
    SetCtlColors $1 0x22304A transparent
    ${NSD_CreateLabel} 0 38u 100% 44u "个人数据包括:设置、长期记忆、技能、上传的音乐、背景与字体。删除后不可恢复。"
    Pop $1
    SetCtlColors $1 0x22304A transparent
    ${NSD_CreateCheckBox} 0 92u 100% 20u "保留我的数据(推荐)"
    Pop $IslandKeepData
    SetCtlColors $IslandKeepData 0x22304A transparent
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
